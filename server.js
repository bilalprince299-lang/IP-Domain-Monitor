const express = require('express');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');
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
    return 'Unknown';
  } catch (e) {
    return 'Unknown';
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

    // Known CDN/Cloud ASNs - IPs owned by these should be highlighted
    const legitimateASNs = [
      'AS13335',  // Cloudflare
      'AS15169',  // Google (includes Firebase)
      'AS20940',  // Akamai
      'AS16509',  // Amazon AWS / CloudFront
      'AS14618',  // Amazon
      'AS8075',   // Microsoft Azure
      'AS54113',  // Fastly
      'AS13414',  // Twitter / X
      'AS32934',  // Facebook / Meta
      'AS14907',  // Wikipedia
      'AS2906',   // Netflix
      'AS36459',  // GitHub
    ];

    // 1) Batch lookup all IPs at once (single API call, very fast)
    const ipInfoMap = {};
    const ipLegitMap = {};
    if (ipItems.length > 0) {
      const ipList = [...new Set(ipItems.map(i => i.host))];
      const batchResult = await batchIpLookup(ipList);
      for (const r of batchResult) {
        if (r.query) {
          const asNum = r.as ? r.as.split(' ')[0] : 'Unknown';
          const ispName = r.isp || r.org || '';
          ipInfoMap[r.query] = ispName ? `${asNum} (${ispName})` : asNum;
          ipLegitMap[r.query] = legitimateASNs.includes(asNum);
        }
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

    // 2b) Check resolved IPs of domains for CDN detection
    const domainCdnMap = {};
    const resolvedIps = [...new Set(domainItems.filter(i => i.resolvedIp).map(i => i.resolvedIp))];
    if (resolvedIps.length > 0) {
      const resolvedBatch = await batchIpLookup(resolvedIps);
      const resolvedAsnMap = {};
      for (const r of resolvedBatch) {
        if (r.query) resolvedAsnMap[r.query] = r.as ? r.as.split(' ')[0] : '';
      }
      for (const item of domainItems) {
        if (item.resolvedIp && resolvedAsnMap[item.resolvedIp]) {
          domainCdnMap[item.host] = legitimateASNs.includes(resolvedAsnMap[item.resolvedIp]);
        }
      }
    }

    // 3) Fetch website titles for ALL items - domains + IPs (parallel, 6s timeout)
    const titleMap = {};
    const allUniqueHosts = [...new Map(items.map(i => [i.host, i])).values()];
    const titleResults = await Promise.all(allUniqueHosts.map(async (d) => {
      const url = `${d.protocol}://${d.host}${d.port ? ':' + d.port : ''}`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'follow',
        });
        clearTimeout(timeout);
        const html = await resp.text();
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return { host: d.host, title: titleMatch ? titleMatch[1].trim().substring(0, 150) : '' };
      } catch (e) {
        return { host: d.host, title: '' };
      }
    }));
    for (const r of titleResults) titleMap[r.host] = r.title;

    // Known legitimate domains & ASNs
    const legitimateDomains = [
      'cloudflare.com', 'google.com', 'googleapis.com', 'google.ae', 'google.co',
      'akamai.net', 'akamai.com', 'akamaitechnologies.com',
      'amazon.com', 'amazon.ae', 'amazonaws.com', 'aws.amazon.com',
      'microsoft.com', 'azure.com', 'live.com', 'outlook.com', 'office.com',
      'fastly.net', 'fastly.com', 'cloudfront.net',
      'digitalocean.com', 'oracle.com', 'ibm.com',
      'facebook.com', 'meta.com', 'instagram.com', 'whatsapp.com',
      'apple.com', 'icloud.com', 'twitter.com', 'x.com',
      'netflix.com', 'youtube.com', 'spotify.com',
      'telegram.org', 'telegram.me',
      'godaddy.com', 'namecheap.com',
    ];

    function isLegitimate(host) {
      const h = host.toLowerCase();
      return legitimateDomains.some(d => h === d || h.endsWith('.' + d));
    }

    // 4) Build Excel rows
    const rows = items.map((item, i) => {
      const contentName = item.port ? `${item.host}:${item.port}` : item.host;
      const originalLink = item.original || `${item.protocol}://${item.host}${item.port ? ':' + item.port : ''}`;
      const info = item.type === 'ip'
        ? (ipInfoMap[item.host] || 'Unknown')
        : (domainInfoMap[item.host] || 'Unknown');
      const websiteTitle = titleMap[item.host] || '';

      return {
        'Sno': i + 1,
        'ContentType': 'APP',
        'ContentName': contentName,
        'Website Title': websiteTitle,
        'WHOIS URL owner / IP INFO for IP': info,
        'Licensee': 'All',
        'IAM Category': 'Infringement of intellectual property rights',
        'Entity': 'Ministry of Economy',
        'Comments': originalLink,
        '_legitimate': item.type === 'ip'
          ? (ipLegitMap[item.host] || false)
          : (isLegitimate(item.host) || domainCdnMap[item.host] || false),
      };
    });

    // 5) Generate Excel with styled header
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet(category || 'Results');

    const headers = ['Sno', 'ContentType', 'ContentName', 'Website Title', 'WHOIS URL owner / IP INFO for IP', 'Licensee', 'IAM Category', 'Entity', 'Comments'];
    ws.addRow(headers);

    // Yellow background + bold + bigger font for header row
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, size: 13, color: { argb: 'FF000000' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4D03F' } };
    headerRow.alignment = { vertical: 'middle' };
    headerRow.height = 28;
    headerRow.eachCell(cell => {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
    });

    // Add data rows - font size 10, highlight legitimate domains/IPs
    const lightGreenFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } };
    for (const row of rows) {
      const dataRow = ws.addRow([row['Sno'], row['ContentType'], row['ContentName'], row['Website Title'], row['WHOIS URL owner / IP INFO for IP'], row['Licensee'], row['IAM Category'], row['Entity'], row['Comments']]);
      dataRow.font = { size: 10 };
      if (row._legitimate) {
        dataRow.eachCell(cell => { cell.fill = lightGreenFill; cell.font = { size: 10 }; });
      }
    }

    // Column widths
    ws.columns.forEach((col, i) => {
      col.width = [6, 14, 35, 35, 45, 10, 45, 22, 50][i] || 15;
    });

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const dateStr = `${dd}${mm}${yyyy}`;
    const fileName = `${category || 'Results'} ${dateStr}_Block_1.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
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
