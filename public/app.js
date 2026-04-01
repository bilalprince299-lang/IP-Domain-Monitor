/**
 * IP Domain Monitor - Frontend Application
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

// --- Parse Links ---
async function parseLinks() {
  const text = document.getElementById('linkInput').value.trim();
  if (!text) {
    showToast('Please paste some links first');
    return;
  }

  const btn = document.getElementById('btnParse');
  btn.disabled = true;
  btn.textContent = 'Parsing...';

  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    const data = await res.json();
    parsedLinks = data.links;

    if (parsedLinks.length === 0) {
      showToast('No valid links found in the text');
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

    // Enable test button
    document.getElementById('btnTest').disabled = false;
    showToast(`${parsedLinks.length} links extracted successfully`);

  } catch (err) {
    showToast('Error parsing links: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Parse Links';
  }
}

// --- Test All Links ---
async function testAll() {
  if (!parsedLinks.length) return;

  const btn = document.getElementById('btnTest');
  btn.disabled = true;
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

            showStats(msg);
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
    btn.textContent = 'Test All';
    setTimeout(() => {
      progress.classList.remove('active');
    }, 2000);
  }
}

// --- Show ISP Banner ---
function showIspBanner(isp, publicIp) {
  const banner = document.getElementById('ispBanner');
  banner.style.display = 'flex';
  document.getElementById('ispName').textContent = isp;
  document.getElementById('ispIp').textContent = publicIp ? `Public IP: ${publicIp}` : '';

  // Show re-test button with opposite ISP name
  const retestBtn = document.getElementById('retestIspBtn');
  const retestName = document.getElementById('retestIspName');

  if (isp === 'Etisalat') {
    retestName.textContent = 'du';
    retestBtn.style.display = 'inline-flex';
  } else if (isp === 'du') {
    retestName.textContent = 'Etisalat';
    retestBtn.style.display = 'inline-flex';
  } else {
    // Non-UAE ISP - still show re-test option
    retestName.textContent = 'Other ISP';
    retestBtn.style.display = 'inline-flex';
  }
}

// --- Re-test on Other ISP ---
async function retestOtherISP() {
  if (!parsedLinks.length) {
    showToast('No links to re-test. Please run a test first.');
    return;
  }

  const otherIsp = document.getElementById('retestIspName').textContent;
  if (!confirm(`Switch your network to ${otherIsp} first!\n\nKya aap ne ${otherIsp} pe switch kar liya hai?`)) {
    return;
  }

  // Re-run test with same parsed links
  const btn = document.getElementById('retestIspBtn');
  btn.disabled = true;
  btn.textContent = 'Testing...';

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
            showStats(msg);
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
    btn.innerHTML = 'Re-test via <strong id="retestIspName">' + otherIsp + '</strong>';
    setTimeout(() => progress.classList.remove('active'), 2000);
  }
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

    return `
      <li class="link-item">
        <div class="link-info">
          <span class="link-host">${esc(url)}</span>
        </div>
        <div class="link-meta">
          ${metaTags}
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

function copySection(type) {
  if (!testResults) return;

  let items;
  if (type === 'active') items = testResults.active.items;
  else if (type === 'down') items = testResults.down.items;
  else if (type === 'blocked') items = testResults.ispBlocked.items;

  if (!items || !items.length) return;

  const text = items.map(item => buildDisplayUrl(item)).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    showToast(`${items.length} links copied to clipboard`);
  });
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

    showIspBanner(testedVia || 'Unknown', null);
    showStats(testResults);
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

    // Agar textarea mein pehle se text hai to new line pe add karo
    if (textarea.value.trim()) {
      textarea.value += '\n' + content;
    } else {
      textarea.value = content;
    }

    showToast(`File "${file.name}" imported successfully`);

    // Reset file input taa ke same file dobara import ho sake
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

// Init
document.addEventListener('DOMContentLoaded', () => {
  // Set initial tab visibility
  document.getElementById('tab-history').style.display = 'none';
});
