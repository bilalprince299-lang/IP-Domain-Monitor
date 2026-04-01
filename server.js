const express = require('express');
const path = require('path');
const { parseLinks } = require('./lib/parser');
const { testLinks, testSingleLink, detectCurrentISP } = require('./lib/tester');
const { saveTestSession, getHistory, getSessionResults, cleanOldData } = require('./lib/db');

const app = express();
const PORT = 3847;

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
  console.log(`IP Domain Monitor running at http://localhost:${PORT}`);
});
