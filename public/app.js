/**
 * AL KHALEEJ IP MONITER - Frontend Application
 */

let parsedLinks = [];
let testResults = null;

// --- Tab Switching ---
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  document.getElementById('tab-monitor').style.display = tab === 'monitor' ? 'block' : 'none';
  document.getElementById('tab-history').style.display = tab === 'history' ? 'block' : 'none';

  if (tab === 'history') loadHistory();
}

// --- Parse & Test (single button) ---
async function parseAndTest() {
  const text = document.getElementById('linkInput').value.trim();
  if (!text) {
    showToast('Please paste some links or domains first');
    return;
  }

  const btn = document.getElementById('btnTest');
  btn.disabled = true;
  btn.textContent = 'Parsing...';

  // Step 1: Parse
  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    const data = await res.json();
    parsedLinks = data.links;

    if (parsedLinks.length === 0) {
      showToast('No valid links found');
      btn.disabled = false;
      btn.textContent = 'Test';
      return;
    }

    // Show parsed table
    const section = document.getElementById('parsedSection');
    section.classList.add('active');
    document.getElementById('parsedCount').textContent = parsedLinks.length;

    const tbody = document.getElementById('parsedTable');
    tbody.innerHTML = parsedLinks.map((link, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(link.host)}</td>
        <td>${link.port || '-'}</td>
        <td>${link.protocol}</td>
        <td><span class="badge ${link.type === 'ip' ? 'badge-blue' : 'badge-green'}">${link.type}</span></td>
        <td style="color: var(--text-dim); font-size: 12px;">${esc(link.original)}</td>
      </tr>
    `).join('');

  } catch (err) {
    showToast('Error parsing links: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Test';
    return;
  }

  // Step 2: Test automatically
  btn.textContent = 'Testing...';

  // Show progress
  const progress = document.getElementById('progressContainer');
  progress.classList.add('active');
  updateProgress(0, parsedLinks.length);

  try {
    const response = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: parsedLinks })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6);
        if (!json) continue;

        try {
          const msg = JSON.parse(json);

          if (msg.type === 'isp') {
            // Show ISP banner
            showIspBanner(msg.isp, msg.publicIp);
          }
          else if (msg.type === 'progress') {
            // Real-time progress update
            updateProgress(msg.completed, msg.total);
          }
          else if (msg.type === 'done') {
            testResults = msg;

            updateProgress(msg.total, msg.total);

            // Hide input & parsed sections
            document.getElementById('inputSection').style.display = 'none';
            document.getElementById('parsedSection').classList.remove('active');
            document.getElementById('newTestBtn').style.display = 'inline-flex';

            try { showStats(msg); } catch(e) { console.error('showStats error:', e); }
            showResults(msg);

            showToast(`Testing complete! ${msg.active.count} active, ${msg.down.count} down, ${msg.ispBlocked.count} ISP blocked`);

            setTimeout(() => {
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }, 300);
          }
          else if (msg.type === 'error') {
            showToast('Error: ' + msg.error);
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }

  } catch (err) {
    showToast('Error testing links: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test';
    setTimeout(() => {
      progress.classList.remove('active');
    }, 2000);
  }
}

// --- ISP Logo Map ---
const ISP_LOGOS = {
  'Etisalat': '/img/etisalat.png',
  'du': '/img/du.png',
};

// --- Show ISP Banner ---
function showIspBanner(isp, publicIp) {
  const banner = document.getElementById('ispBanner');
  banner.style.display = 'flex';
  document.getElementById('ispName').textContent = isp;
  document.getElementById('ispIp').textContent = publicIp ? `Public IP: ${publicIp}` : '';

  // Show ISP logo
  const logo = document.getElementById('ispLogo');
  if (ISP_LOGOS[isp]) {
    logo.src = ISP_LOGOS[isp];
    logo.alt = isp;
    logo.style.display = 'block';
  } else {
    logo.style.display = 'none';
  }

  // Show re-test button with opposite ISP
  const retestBtn = document.getElementById('retestIspBtn');
  const retestName = document.getElementById('retestIspName');
  const retestLogo = document.getElementById('retestIspLogo');
  let otherIsp = '';

  if (isp === 'Etisalat') {
    otherIsp = 'du';
  } else if (isp === 'du') {
    otherIsp = 'Etisalat';
  } else {
    otherIsp = 'Other ISP';
  }

  if (retestName) retestName.textContent = otherIsp;
  if (retestBtn) retestBtn.style.display = 'inline-flex';

  if (retestLogo) {
    if (ISP_LOGOS[otherIsp]) {
      retestLogo.src = ISP_LOGOS[otherIsp];
      retestLogo.alt = otherIsp;
      retestLogo.style.display = 'block';
    } else {
      retestLogo.style.display = 'none';
    }
  }
}

// --- Re-test on Other ISP ---
async function retestOtherISP() {
  if (!parsedLinks.length) {
    showToast('No links to re-test. Please run a test first.');
    return;
  }

  const otherIsp = document.getElementById('retestIspName').textContent;
  if (!confirm(`Please switch your network to ${otherIsp} first.\n\nHave you switched to ${otherIsp}?`)) {
    return;
  }

  // Re-run test with same parsed links
  const btn = document.getElementById('retestIspBtn');
  btn.disabled = true;

  // Clear old results before re-testing
  resetResults();

  const progress = document.getElementById('progressContainer');
  progress.classList.add('active');
  updateProgress(0, parsedLinks.length);

  try {
    const response = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: parsedLinks })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'isp') {
            showIspBanner(msg.isp, msg.publicIp);
          } else if (msg.type === 'progress') {
            updateProgress(msg.completed, msg.total);
          } else if (msg.type === 'done') {
            testResults = msg;
            updateProgress(msg.total, msg.total);
            try { showStats(msg); } catch(e) { console.error('showStats error:', e); }
            showResults(msg);
            showToast(`Re-test complete via ${msg.testedVia}! ${msg.active.count} active, ${msg.down.count} down, ${msg.ispBlocked.count} ISP blocked`);
            setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 300);
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    showToast('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    // Don't overwrite - showIspBanner already set the correct button
    setTimeout(() => progress.classList.remove('active'), 2000);
  }
}

// --- Reset Results (clear old data before re-test) ---
function resetResults() {
  // Clear all result lists
  ['activeList', 'downList', 'blockedList'].forEach(id => {
    const list = document.getElementById(id);
    list.style.display = 'none';
    list.innerHTML = '';
  });

  // Hide all result cards
  ['activeCard', 'downCard', 'blockedCard'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });

  // Reset stats to 0
  document.getElementById('statTotal').textContent = '0';
  document.getElementById('statActive').textContent = '0';
  document.getElementById('statDown').textContent = '0';
  document.getElementById('statBlocked').textContent = '0';

  // Clear testResults
  testResults = null;
}

// --- Show Stats ---
function showStats(data) {
  const bar = document.getElementById('statsBar');
  bar.classList.add('active');
  document.getElementById('statTotal').textContent = data.total;
  document.getElementById('statActive').textContent = data.active.count;
  document.getElementById('statDown').textContent = data.down.count;
  document.getElementById('statBlocked').textContent = data.ispBlocked.count;

  // Show ISP banner if available
  if (data.testedVia) {
    showIspBanner(data.testedVia, data.publicIp);
  }
}

// --- Show Results ---
function showResults(data) {
  const section = document.getElementById('resultsSection');
  section.classList.add('active');

  // Reset all lists to hidden and toggle buttons to "Show"
  ['activeList', 'downList', 'blockedList'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.querySelectorAll('.result-card .card-actions .btn-outline').forEach(btn => {
    btn.textContent = 'Show';
  });

  // Active
  renderResultList('active', data.active.items, 'activeCard', 'activeList', 'activeCount');
  // Down
  renderResultList('down', data.down.items, 'downCard', 'downList', 'downCount');
  // ISP Blocked
  renderResultList('blocked', data.ispBlocked.items, 'blockedCard', 'blockedList', 'blockedCount');
}

function renderResultList(type, items, cardId, listId, countId) {
  const card = document.getElementById(cardId);
  const list = document.getElementById(listId);
  const count = document.getElementById(countId);

  if (items.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  count.textContent = items.length;

  list.innerHTML = items.map(item => {
    const url = buildDisplayUrl(item);
    let metaTags = '';

    if (item.port) {
      metaTags += `<span class="tag port">:${item.port}</span>`;
    }
    if (item.resolvedIp) {
      metaTags += `<span class="tag ip">${esc(item.resolvedIp)}</span>`;
    }
    if (item.responseTime) {
      metaTags += `<span class="tag time">${item.responseTime}ms</span>`;
    }
    if (item.ispName) {
      metaTags += `<span class="tag isp">${esc(item.ispName)}</span>`;
    }
    if (item.statusCode) {
      metaTags += `<span class="tag">${item.statusCode}</span>`;
    }
    if (item.error) {
      metaTags += `<span class="tag" title="${esc(item.error)}">${truncate(item.error, 20)}</span>`;
    }

    const infoType = item.type === 'ip' ? 'ip' : 'domain';
    const infoHost = item.type === 'ip' ? item.host : item.host;

    return `
      <li class="link-item">
        <div class="link-info">
          <span class="link-host">${esc(url)}</span>
        </div>
        <div class="link-meta">
          ${metaTags}
          <button class="btn-info" onclick="lookupInfo('${esc(infoHost)}', '${infoType}', this)" title="${infoType === 'ip' ? 'ASN Info' : 'WHOIS Info'}">i</button>
          <button class="btn-copy" onclick="copyText('${esc(url)}', this)">Copy</button>
        </div>
      </li>
    `;
  }).join('');
}

function buildDisplayUrl(item) {
  if (item.port) {
    return `${item.protocol}://${item.host}:${item.port}`;
  }
  return `${item.protocol}://${item.host}`;
}

// --- Copy Functions ---
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      btn.classList.add('copied');
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = 'Copy';
      }, 1500);
    }
  });
}

function copySection(type, mode) {
  if (!testResults) return;

  let items;
  if (type === 'active') items = testResults.active.items;
  else if (type === 'down') items = testResults.down.items;
  else if (type === 'blocked') items = testResults.ispBlocked.items;

  if (!items || !items.length) return;

  let text = '';

  if (mode === 'domains') {
    // Domain/IP + port only (without protocol)
    text = items.map(item => {
      if (item.port) return `${item.host}:${item.port}`;
      return item.host;
    }).join('\n');
  }
  else if (mode === 'links') {
    // Original full URLs as pasted
    text = items.map(item => item.original || buildDisplayUrl(item)).join('\n');
  }
  else if (mode === 'all') {
    // Both - original links first, then domains/IPs below
    const links = items.map(item => item.original || buildDisplayUrl(item)).join('\n');
    const domains = items.map(item => {
      if (item.port) return `${item.host}:${item.port}`;
      return item.host;
    }).join('\n');
    text = `--- Links ---\n${links}\n\n--- Domains/IPs ---\n${domains}`;
  }

  navigator.clipboard.writeText(text).then(() => {
    const labels = { domains: 'Domains', links: 'Links', all: 'Links + Domains' };
    showToast(`${items.length} ${labels[mode]} copied to clipboard`);
  });
}

// --- Info Lookup (ASN / WHOIS) ---
async function lookupInfo(host, type, btn) {
  // Close any existing popup
  document.querySelectorAll('.info-popup').forEach(p => p.remove());

  btn.classList.add('loading');
  btn.textContent = '...';

  try {
    const res = await fetch(`/api/info?host=${encodeURIComponent(host)}&type=${type}`);
    const data = await res.json();

    const popup = document.createElement('div');
    popup.className = 'info-popup';

    if (data.error) {
      popup.innerHTML = `<div class="info-row"><span class="info-label">Error</span><span class="info-val">${esc(data.error)}</span></div>`;
    } else if (data.type === 'ip') {
      popup.innerHTML = `
        <div class="info-header">${esc(host)} <span class="info-type">IP</span></div>
        <div class="info-row"><span class="info-label">ASN</span><span class="info-val">${esc(data.asn)}</span></div>
        ${data.isp ? `<div class="info-row"><span class="info-label">ISP</span><span class="info-val">${esc(data.isp)}</span></div>` : ''}
        ${data.org ? `<div class="info-row"><span class="info-label">Org</span><span class="info-val">${esc(data.org)}</span></div>` : ''}
        ${data.country ? `<div class="info-row"><span class="info-label">Country</span><span class="info-val">${esc(data.country)}</span></div>` : ''}
      `;
    } else {
      popup.innerHTML = `
        <div class="info-header">${esc(host)} <span class="info-type">Domain</span></div>
        <div class="info-row"><span class="info-label">Registrant</span><span class="info-val">${esc(data.registrant)}</span></div>
        <div class="info-row"><span class="info-label">Registrar</span><span class="info-val">${esc(data.registrar)}</span></div>
        ${data.created ? `<div class="info-row"><span class="info-label">Created</span><span class="info-val">${esc(data.created)}</span></div>` : ''}
        ${data.expires ? `<div class="info-row"><span class="info-label">Expires</span><span class="info-val">${esc(data.expires)}</span></div>` : ''}
        ${data.nameServers.length ? `<div class="info-row"><span class="info-label">NS</span><span class="info-val">${data.nameServers.map(esc).join(', ')}</span></div>` : ''}
      `;
    }

    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'info-close';
    closeBtn.textContent = 'x';
    closeBtn.onclick = () => popup.remove();
    popup.prepend(closeBtn);

    // Insert popup after the link-item
    const li = btn.closest('.link-item');
    li.after(popup);

  } catch (err) {
    showToast('Lookup failed: ' + err.message);
  } finally {
    btn.classList.remove('loading');
    btn.textContent = 'i';
  }
}

// --- Export Excel (per section) ---
async function exportExcel(type, btn) {
  if (!testResults) return;

  let items;
  const category = 'StarzPlay';
  if (type === 'active') { items = testResults.active.items; }
  else if (type === 'down') { items = testResults.down.items; }
  else if (type === 'blocked') { items = testResults.ispBlocked.items; }

  if (!items || !items.length) return;

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Loading...';

  try {
    const res = await fetch('/api/export-excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, category })
    });

    if (!res.ok) throw new Error('Export failed');

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    a.download = `${category} ${dd}${mm}${yyyy}_Block_1.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`${items.length} items exported to Excel`);
  } catch (err) {
    showToast('Excel export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// --- Export CSV ---
function exportCsv() {
  if (!testResults) {
    showToast('No results to export. Run a test first.');
    return;
  }

  const allResults = [
    ...testResults.active.items,
    ...testResults.down.items,
    ...testResults.ispBlocked.items,
  ];

  // Build CSV
  const csv = [
    'Status,Host,Port,Protocol,Type,Status Code,Resolved IP,Response Time (ms),ISP,Error',
    ...allResults.map(r =>
      [r.status, r.host, r.port || '', r.protocol, r.type, r.statusCode || '', r.resolvedIp || '', r.responseTime || '', r.ispName || '', r.error || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ip-monitor-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported successfully');
}

// --- History ---
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const sessions = await res.json();
    const container = document.getElementById('historyList');

    if (!sessions.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">---</div>
          <p>No history yet. Run a test to see results here.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = sessions.map(s => `
      <div class="history-item" onclick="loadSession(${s.id}, '${esc(s.tested_via || 'Unknown')}')">
        <div>
          <div class="history-date">${formatDate(s.created_at)}</div>
          <div style="font-size:12px; color:var(--text-dim); margin-top:2px;">via <strong style="color:var(--blue)">${esc(s.tested_via || 'Unknown')}</strong></div>
        </div>
        <div class="history-stats">
          <span class="history-stat"><span class="badge badge-blue">${s.total_links}</span> Total</span>
          <span class="history-stat"><span class="badge badge-green">${s.active_count}</span> Active</span>
          <span class="history-stat"><span class="badge badge-red">${s.down_count}</span> Down</span>
          <span class="history-stat"><span class="badge badge-orange">${s.blocked_count}</span> Blocked</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('Error loading history');
  }
}

async function loadSession(id, testedVia) {
  try {
    const res = await fetch(`/api/history/${id}`);
    const results = await res.json();

    // Switch to monitor tab and show results
    switchTab('monitor');

    const active = results.filter(r => r.status === 'active').map(mapDbResult);
    const down = results.filter(r => r.status === 'down').map(mapDbResult);
    const blocked = results.filter(r => r.status === 'isp_blocked').map(mapDbResult);

    testResults = {
      total: results.length,
      testedVia: testedVia || 'Unknown',
      active: { count: active.length, items: active },
      down: { count: down.length, items: down },
      ispBlocked: { count: blocked.length, items: blocked },
    };

    document.getElementById('inputSection').style.display = 'none';
    document.getElementById('newTestBtn').style.display = 'inline-flex';

    try { showIspBanner(testedVia || 'Unknown', null); } catch(e) {}
    try { showStats(testResults); } catch(e) {}
    showResults(testResults);

    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 300);

  } catch (err) {
    showToast('Error loading session');
  }
}

function mapDbResult(r) {
  return {
    original: r.original,
    host: r.host,
    port: r.port,
    protocol: r.protocol,
    type: r.type,
    status: r.status,
    statusCode: r.status_code,
    resolvedIp: r.resolved_ip,
    responseTime: r.response_time,
    error: r.error,
    ispName: r.isp_name,
  };
}

// --- Toggle Parsed Links Table ---
function toggleParsedTable() {
  const wrap = document.getElementById('parsedTableWrap');
  const btn = document.getElementById('btnToggleLinks');
  if (wrap.style.display === 'none') {
    wrap.style.display = 'block';
    btn.textContent = 'Hide Links';
  } else {
    wrap.style.display = 'none';
    btn.textContent = 'Show Links';
  }
}

// --- Toggle Result List (Active/Down/Blocked) ---
function toggleResultList(listId, btn) {
  const list = document.getElementById(listId);
  if (list.style.display === 'none') {
    list.style.display = 'block';
    btn.textContent = 'Hide';
  } else {
    list.style.display = 'none';
    btn.textContent = 'Show';
  }
}

// --- New Test (restart) ---
function newTest() {
  // Show input section again
  document.getElementById('inputSection').style.display = 'block';
  document.getElementById('newTestBtn').style.display = 'none';

  // Hide results & ISP banner
  document.getElementById('ispBanner').style.display = 'none';
  document.getElementById('statsBar').classList.remove('active');
  document.getElementById('resultsSection').classList.remove('active');
  document.getElementById('progressContainer').classList.remove('active');

  // Clear data
  document.getElementById('linkInput').value = '';
  document.getElementById('btnTest').disabled = true;
  parsedLinks = [];
  testResults = null;

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Import File ---
function importFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const content = e.target.result;
    const textarea = document.getElementById('linkInput');

    // Append to existing text if textarea is not empty
    if (textarea.value.trim()) {
      textarea.value += '\n' + content;
    } else {
      textarea.value = content;
    }

    showToast(`File "${file.name}" imported successfully`);

    // Reset file input so same file can be re-imported
    event.target.value = '';
  };

  reader.onerror = function() {
    showToast('Error reading file');
  };

  reader.readAsText(file);
}

// --- Clear History ---
async function clearHistory() {
  if (!confirm('Are you sure? All history will be deleted.')) return;
  try {
    await fetch('/api/history', { method: 'DELETE' });
    showToast('History cleared');
    loadHistory();
  } catch (err) {
    showToast('Error clearing history');
  }
}

// --- Clear ---
function clearAll() {
  document.getElementById('linkInput').value = '';
  document.getElementById('parsedSection').classList.remove('active');
  document.getElementById('statsBar').classList.remove('active');
  document.getElementById('resultsSection').classList.remove('active');
  document.getElementById('progressContainer').classList.remove('active');
  document.getElementById('btnTest').disabled = true;
  parsedLinks = [];
  testResults = null;
}

// --- Utilities ---
function updateProgress(current, total) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = `Testing ${current} / ${total}`;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'Z');
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// --- Theme Toggle ---
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('themeToggle');
  // Moon for dark, Sun for light
  btn.innerHTML = theme === 'dark' ? '&#9790;' : '&#9728;';
}

function loadTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  // Set initial tab visibility
  document.getElementById('tab-history').style.display = 'none';
  // Load saved theme
  loadTheme();
});
