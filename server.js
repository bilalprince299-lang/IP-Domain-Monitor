const express = require('express');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const XLSX = require('xlsx');
const { parseLinks } = require('./lib/parser');
const { testLinks, testSingleLink, detectCurrentISP } = require('./lib/tester');
const { saveTestSession, getHistory, getSessionResults, cleanOldData } = require('./lib/db');

const app = express();
const PORT = 2397;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Parse links from text
app.post('/api/parse', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const links = parseLinks(text);
  res.json({ links, count: links.length });
});

// Detect current ISP
app.get('/api/isp', async (req, res) => {
  try {
    const ispInfo = await detectCurrentISP();
    res.json(ispInfo);
  } catch (err) {
    res.json({ isp: 'Unknown', error: err.message });
  }
});

// Test all parsed links with real-time progress (SSE)
app.post('/api/test', async (req, res) => {
  const { links } = req.body;
  if (!links || !links.length) return res.status(400).json({ error: 'No links provided' });

  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // Detect ISP before testing
    const ispInfo = await detectCurrentISP();
    res.write(`data: ${JSON.stringify({ type: 'isp', isp: ispInfo.isp, publicIp: ispInfo.publicIp || null })}\n\n`);

    // Test with progress callback
    const results = await testLinks(links, (completed, total) => {
      res.write(`data: ${JSON.stringify({ type: 'progress', completed, total })}\n\n`);
    });

    // Save to history with ISP info
    const sessionId = saveTestSession(results, ispInfo.isp);

    const active = results.filter(r => r.status === 'active');
    const down = results.filter(r => r.status === 'down');
    const ispBlocked = results.filter(r => r.status === 'isp_blocked');

    res.write(`data: ${JSON.stringify({
      type: 'done',
      sessionId,
      testedVia: ispInfo.isp,
      publicIp: ispInfo.publicIp || null,
      total: results.length,
      active: { count: active.length, items: active },
      down: { count: down.length, items: down },
      ispBlocked: { count: ispBlocked.length, items: ispBlocked },
    })}\n\n`);

    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// Lookup IP ASN or Domain WHOIS info
app.get('/api/info', async (req, res) => {
  const { host, type } = req.query;
  if (!host) return res.status(400).json({ error: 'No host provided' });

  try {
    if (type === 'ip') {
      // IP ASN lookup via ip-api.com
      const data = await new Promise((resolve, reject) => {
        http.get(`http://ip-api.com/json/${host}?fields=query,as,asname,isp,org,country`, (resp) => {
          let body = '';
          resp.on('data', c => body += c);
          resp.on('end', () => resolve(JSON.parse(body)));
          resp.on('error', reject);
        }).on('error', reject);
      });
      res.json({
        type: 'ip',
        host,
        asn: data.as || 'Unknown',
        asname: data.asname || '',
        isp: data.isp || '',
        org: data.org || '',
        country: data.country || '',
      });
    } else {
      // Domain WHOIS lookup via whois command
      const raw = execSync(`whois ${host} 2>/dev/null`, { timeout: 10000, encoding: 'utf-8' });

      // Parse registrant info
      let registrant = '', registrarName = '', creationDate = '', expiryDate = '', nameServers = [];
      for (const line of raw.split('\n')) {
        const l = line.trim().toLowerCase();
        const val = line.split(':').slice(1).join(':').trim();
        if (l.startsWith('registrant organization') || l.startsWith('registrant name') || l.startsWith('org-name')) {
          if (!registrant) registrant = val;
        }
        if (l.startsWith('registrar:') || l.startsWith('registrar name')) {
          if (!registrarName) registrarName = val;
        }
        if (l.startsWith('creation date') || l.startsWith('created')) {
          if (!creationDate) creationDate = val;
        }
        if (l.startsWith('registry expiry date') || l.startsWith('expiry date') || l.startsWith('registrar registration expiration')) {
          if (!expiryDate) expiryDate = val;
        }
        if (l.startsWith('name server')) {
          nameServers.push(val);
        }
      }

      res.json({
        type: 'domain',
        host,
        registrant: registrant || 'REDACTED / Not available',
        registrar: registrarName || 'Unknown',
        created: creationDate || '',
        expires: expiryDate || '',
        nameServers: nameServers.slice(0, 2),
      });
    }
  } catch (err) {
    res.json({ type, host, error: err.message || 'Lookup failed' });
  }
});

// Batch IP lookup via ip-api.com (up to 100 at once)
async function batchIpLookup(ips) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(ips.map(ip => ({ query: ip, fields: 'query,as,isp,org' })));
    const options = {
      hostname: 'ip-api.com', port: 80, path: '/batch', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = http.request(options, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.write(postData);
    req.end();
  });
}

// Fast WHOIS lookup with 4s timeout
function quickWhois(host) {
  try {
    const raw = execSync(`whois ${host} 2>/dev/null`, { timeout: 4000, encoding: 'utf-8' });
    for (const line of raw.split('\n')) {
      const l = line.trim().toLowerCase();
      const val = line.split(':').slice(1).join(':').trim();
      if (l.startsWith('registrant organization') || l.startsWith('registrant name') || l.startsWith('org-name')) {
        if (val) return val;
      }
    }
    return 'REDACTED / Not available';
  } catch (e) {
    return 'Lookup timeout';
  }
}

// Export Excel with WHOIS/ASN info
app.post('/api/export-excel', async (req, res) => {
  const { items, category } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'No items' });

  try {
    // Separate IPs and domains
    const ipItems = items.filter(i => i.type === 'ip');
    const domainItems = items.filter(i => i.type !== 'ip');

    // 1) Batch lookup all IPs at once (single API call, very fast)
    const ipInfoMap = {};
    if (ipItems.length > 0) {
      const ipList = [...new Set(ipItems.map(i => i.host))];
      const batchResult = await batchIpLookup(ipList);
      for (const r of batchResult) {
        if (r.query) ipInfoMap[r.query] = `${r.as || 'Unknown'} (${r.isp || r.org || ''})`;
      }
    }

    // 2) WHOIS for domains - all in parallel (fast with 4s timeout)
    const domainInfoMap = {};
    if (domainItems.length > 0) {
      const uniqueDomains = [...new Set(domainItems.map(i => i.host))];
      const whoisResults = await Promise.all(uniqueDomains.map(d =>
        new Promise(resolve => resolve({ host: d, info: quickWhois(d) }))
      ));
      for (const r of whoisResults) domainInfoMap[r.host] = r.info;
    }

    // 3) Build Excel rows
    const rows = items.map((item, i) => {
      const contentName = item.port ? `${item.host}:${item.port}` : item.host;
      const originalLink = item.original || `${item.protocol}://${item.host}${item.port ? ':' + item.port : ''}`;
      const info = item.type === 'ip'
        ? (ipInfoMap[item.host] || 'Unknown')
        : (domainInfoMap[item.host] || 'Unknown');

      return {
        'Sno': i + 1,
        'ContentType': 'APP',
        'ContentName': contentName,
        'WHOIS URL owner / IP INFO for IP': info,
        'Licensee': 'All',
        'IAM Category': 'Infringement of intellectual property rights',
        'Entity': 'Ministry of Economy',
        'Comments': originalLink,
      };
    });

    // 4) Generate Excel
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 5 }, { wch: 14 }, { wch: 35 }, { wch: 45 },
      { wch: 10 }, { wch: 45 }, { wch: 22 }, { wch: 50 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, category || 'Results');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=AL-KHALEEJ-${(category || 'results').toUpperCase()}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    res.send(buffer);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-test a single link
app.post('/api/retest', async (req, res) => {
  const { link } = req.body;
  if (!link) return res.status(400).json({ error: 'No link provided' });

  try {
    const result = await testSingleLink(link);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get history
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const sessions = getHistory(limit);
  res.json(sessions);
});

// Get session details
app.get('/api/history/:id', (req, res) => {
  const results = getSessionResults(parseInt(req.params.id));
  res.json(results);
});

// Export CSV
app.post('/api/export', (req, res) => {
  const { results } = req.body;
  if (!results) return res.status(400).json({ error: 'No results' });

  const csv = [
    'Status,Host,Port,Protocol,Type,Status Code,Resolved IP,Response Time (ms),ISP,Error',
    ...results.map(r =>
      [r.status, r.host, r.port || '', r.protocol, r.type, r.statusCode || '', r.resolvedIp || '', r.responseTime || '', r.ispName || '', r.error || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=ip-monitor-results.csv');
  res.send(csv);
});

// Clear all history
app.delete('/api/history', (req, res) => {
  const db = require('./lib/db').getDb();
  db.exec('DELETE FROM test_results');
  db.exec('DELETE FROM test_sessions');
  res.json({ success: true });
});

// Clean old data on startup
cleanOldData();

// Clean old data every 24 hours
setInterval(cleanOldData, 24 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AL KHALEEJ IP MONITER running at http://localhost:${PORT}`);
});
