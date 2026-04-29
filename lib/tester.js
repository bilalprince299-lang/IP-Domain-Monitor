/**
 * HTTP Testing Engine - Tests links and categorizes them
 * Categories: active, down, isp_blocked
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const { URL } = require('url');

const os = require('os');
const { execSync } = require('child_process');

const TIMEOUT = 12000; // 12 seconds - enough for ISP block pages

// --- Auto Detect Current ISP via ip-api.com (free, no key needed) ---
async function detectCurrentISP() {
  return new Promise((resolve) => {
    const req = http.get('http://ip-api.com/json/?fields=query,isp,org,country,as', { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          let ispName = data.isp || data.org || 'Unknown';

          // Normalize UAE ISP names
          // IMPORTANT: Check du FIRST because "Emirates Integrated" = du, "Emirates Telecom" = Etisalat
          const ispCheck = `${data.isp || ''} ${data.org || ''} ${data.as || ''}`;
          if (/emirates.*integrated|eitc|AS15802|\bdu\b/i.test(ispCheck)) {
            ispName = 'du';
          } else if (/etisalat|emirates.*telecom|emirates.*internet|AS5384/i.test(ispCheck)) {
            ispName = 'Etisalat';
          }

          resolve({
            isp: ispName,
            publicIp: data.query,
            country: data.country,
            method: 'api'
          });
        } catch (e) {
          resolve({ isp: 'Unknown', method: 'error', error: e.message });
        }
      });
    });
    req.on('error', () => resolve({ isp: 'Unknown', method: 'error' }));
    req.on('timeout', () => { req.destroy(); resolve({ isp: 'Unknown', method: 'timeout' }); });
  });
}

// Known ISP block page patterns (Etisalat & du - UAE)
const ISP_BLOCK_PATTERNS = [
  // TRA (Telecommunications Regulatory Authority) patterns
  /blocked.*by.*regulatory/i,
  /telecommunications.*regulatory.*authority/i,
  /tra\.gov\.ae/i,
  /tdra\.gov\.ae/i,
  // Etisalat patterns
  /etisalat.*block/i,
  /elife.*block/i,
  /access.*denied.*etisalat/i,
  /content.*blocked.*etisalat/i,
  // du patterns
  /du\.ae.*block/i,
  /eitc.*block/i,
  /access.*denied.*du/i,
  /content.*blocked.*du/i,
  // Generic UAE ISP block patterns
  /this.*site.*has.*been.*blocked/i,
  /website.*blocked.*uae/i,
  /blocked.*internet.*service.*provider/i,
  /url.*blocked.*as.*per/i,
  /access.*restricted.*by.*isp/i,
  /blocked.*as.*per.*uae.*law/i,
  /internet.*access.*management/i,
  /regulatory.*framework/i,
  // Common block page indicators
  /proxy\.dp\.ae/i,
  /block\.du\.ae/i,
  /block\.etisalat/i,
  /blockpage/i,
];

function resolveDns(hostname) {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

// Fallback DNS via DNS-over-HTTPS (DoH) - ISPs cannot intercept HTTPS port 443
// Unlike plain DNS on port 53, DoH bypasses ISP DNS interception/hijacking
function resolveWithDoH(hostname) {
  return new Promise((resolve, reject) => {
    // Try Google DoH first, then Cloudflare DoH
    const providers = [
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    ];

    let tried = 0;

    function tryProvider(url) {
      const req = https.request(url, { headers: { 'Accept': 'application/dns-json' }, timeout: 6000 }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const answers = (data.Answer || []).filter(a => a.type === 1); // type 1 = A record
            if (answers.length > 0) {
              resolve(answers.map(a => a.data));
            } else {
              // No A records found
              tried++;
              if (tried < providers.length) {
                tryProvider(providers[tried]);
              } else {
                reject(new Error('No A records from DoH'));
              }
            }
          } catch (e) {
            tried++;
            if (tried < providers.length) tryProvider(providers[tried]);
            else reject(e);
          }
        });
      });
      req.on('error', () => {
        tried++;
        if (tried < providers.length) tryProvider(providers[tried]);
        else reject(new Error('DoH lookup failed'));
      });
      req.on('timeout', () => {
        req.destroy();
        tried++;
        if (tried < providers.length) tryProvider(providers[tried]);
        else reject(new Error('DoH timeout'));
      });
      req.end();
    }

    tryProvider(providers[0]);
  });
}

// Legacy fallback: Google DNS on port 53 (may be intercepted by ISP)
function resolveWithGoogleDns(hostname) {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8', '8.8.4.4']);
    resolver.resolve4(hostname, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

function httpRequest(url, timeout = TIMEOUT, maxRedirects = 5, overrideIp = null) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    function doRequest(requestUrl, ipOverride) {
      const parsedUrl = new URL(requestUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      // If an overrideIp is provided, connect to that IP directly
      // but keep Host header + SNI = original hostname (simulates browser with DoH)
      const connectHost = ipOverride || parsedUrl.hostname;
      // Host header: omit default ports (443 for https, 80 for http) like browsers do
      const isDefaultPort = (parsedUrl.protocol === 'https:' && parsedUrl.port === '443')
        || (parsedUrl.protocol === 'http:' && parsedUrl.port === '80')
        || !parsedUrl.port;
      const hostHeader = isDefaultPort
        ? parsedUrl.hostname
        : `${parsedUrl.hostname}:${parsedUrl.port}`;

      // SNI can only be a hostname, not an IP. Only set it if URL is a hostname.
      const hostnameIsIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsedUrl.hostname)
        || parsedUrl.hostname.includes(':'); // IPv6

      const options = {
        hostname: connectHost,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout: timeout,
        headers: {
          'Host': hostHeader,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        rejectUnauthorized: false,
      };

      // Only add SNI servername for hostname URLs (TLS disallows IP in SNI)
      if (!hostnameIsIp && parsedUrl.protocol === 'https:') {
        options.servername = parsedUrl.hostname;
      }

      const req = client.request(options, (res) => {
        // Auto-follow redirects to catch ISP block pages
        if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && redirectCount < maxRedirects) {
          redirectCount++;
          let redirectUrl = res.headers.location;
          // Handle relative redirects
          if (redirectUrl.startsWith('/')) {
            redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
          }
          res.resume(); // drain response
          // Same-host redirect: keep using override IP. Different host: let it resolve normally.
          const nextParsed = new URL(redirectUrl);
          const sameHost = nextParsed.hostname === parsedUrl.hostname;
          doRequest(redirectUrl, sameHost ? ipOverride : null);
          return;
        }

        let body = '';
        const maxBody = 50000;

        res.on('data', (chunk) => {
          if (body.length < maxBody) {
            body += chunk.toString();
          }
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: body,
            redirectUrl: res.headers.location || null,
            finalUrl: requestUrl,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('TIMEOUT'));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    }

    doRequest(url, overrideIp);
  });
}

function isIspBlocked(response) {
  if (!response || !response.body) return false;

  const body = response.body;

  for (const pattern of ISP_BLOCK_PATTERNS) {
    if (pattern.test(body)) {
      return true;
    }
  }

  // Check if redirected to known block page URLs
  if (response.redirectUrl) {
    const blockRedirects = ['proxy.dp.ae', 'block.du.ae', 'block.etisalat', 'blockpage'];
    for (const br of blockRedirects) {
      if (response.redirectUrl.toLowerCase().includes(br)) {
        return true;
      }
    }
  }

  return false;
}

async function testSingleLink(entry) {
  const result = {
    ...entry,
    status: 'unknown',
    statusCode: null,
    resolvedIp: null,
    responseTime: null,
    error: null,
    ispName: null,
  };

  const startTime = Date.now();

  try {
    // Resolve DNS for domains - detect ISP DNS blocks
    if (entry.type === 'domain') {
      try {
        const ips = await resolveDns(entry.host);
        result.resolvedIp = ips[0];
      } catch (dnsErr) {
        // System DNS failed - try DoH (DNS-over-HTTPS) to bypass ISP interception
        // UAE ISPs often intercept ALL port 53 traffic, so plain Google DNS also fails
        try {
          const dohIps = await resolveWithDoH(entry.host);
          // DoH works but system DNS failed = ISP DNS block confirmed
          result.resolvedIp = dohIps[0];
          result.dnsBlocked = true;
        } catch (dohErr) {
          // DoH also failed - try legacy Google DNS as last resort
          try {
            const googleIps = await resolveWithGoogleDns(entry.host);
            result.resolvedIp = googleIps[0];
            result.dnsBlocked = true;
          } catch (googleErr) {
            // All DNS methods failed = domain truly down
            result.status = 'down';
            result.error = `DNS resolution failed: ${dnsErr.code || dnsErr.message}`;
            result.responseTime = Date.now() - startTime;
            return result;
          }
        }
      }
    }

    // Build test URLs and test in parallel
    const urls = buildTestUrls(entry);

    // If ISP DNS was blocked, use the Google-resolved IP to connect directly
    // (simulates browser bypassing via DoH). Host header + SNI stay original.
    const overrideIp = result.dnsBlocked ? result.resolvedIp : null;

    // Race all URLs in parallel - first successful response wins
    const responses = await Promise.allSettled(
      urls.map(url => httpRequest(url, TIMEOUT, 5, overrideIp))
    );

    let bestResponse = null;
    let lastError = null;

    for (const r of responses) {
      if (r.status === 'fulfilled') {
        const response = r.value;

        // Check ISP block first
        if (isIspBlocked(response)) {
          result.statusCode = response.statusCode;
          result.responseTime = Date.now() - startTime;
          result.status = 'isp_blocked';
          if (/\bdu\b|eitc|emirates.*integrated/i.test(response.body)) {
            result.ispName = 'du';
          } else if (/etisalat|elife/i.test(response.body)) {
            result.ispName = 'Etisalat';
          } else {
            result.ispName = 'UAE ISP';
          }
          if (result.dnsBlocked) {
            result.error = 'DNS + HTTP blocked by ISP';
          }
          return result;
        }

        // Any response means server is alive
        if (response.statusCode >= 200 && response.statusCode < 600) {
          if (!bestResponse || (response.statusCode < 400 && bestResponse.statusCode >= 400)) {
            bestResponse = response;
          }
        }
      } else {
        lastError = r.reason?.message || 'Request failed';
      }
    }

    if (bestResponse) {
      result.statusCode = bestResponse.statusCode;
      result.responseTime = Date.now() - startTime;
      // Site is reachable - mark ACTIVE (even if DNS was ISP-blocked,
      // because browsers with DoH can access it, so block is ineffective).
      result.status = 'active';
      if (result.dnsBlocked) {
        result.dnsBlockBypassable = true;
        result.error = 'DNS blocked by ISP but site accessible (bypassable via DoH)';
      }
      return result;
    }

    // All URLs failed
    if (result.dnsBlocked) {
      // DNS blocked AND can't reach via Google IP = full ISP block (DNS + IP level)
      result.status = 'isp_blocked';
      result.ispName = 'UAE ISP';
      result.error = 'DNS blocked by ISP (IP also unreachable)';
    } else {
      result.status = 'down';
      result.error = lastError;
    }
    result.responseTime = Date.now() - startTime;

  } catch (err) {
    result.status = 'down';
    result.error = err.message;
    result.responseTime = Date.now() - startTime;
  }

  return result;
}

function buildTestUrls(entry) {
  if (entry.port) {
    return [`${entry.protocol}://${entry.host}:${entry.port}/`];
  }
  // HTTPS first (most sites use HTTPS), then HTTP fallback
  return [`https://${entry.host}:443/`, `http://${entry.host}:80/`];
}

// =====================================================================
// DEEP VERIFICATION - Multi-stage cross-validation for ~99% accuracy
// =====================================================================
// Strategy:
//   Stage 1: DNS check (system + DoH cross-reference) - detect DNS poisoning
//   Stage 2: TCP connection (with retries on transient errors)
//   Stage 3: HTTP content check (status + title + body fingerprint + size + TLS)
//   Stage 4: Final decision via confidence score from all stages

const DEEP_TIMEOUT = 15000;

// Heuristic: detect block pages by content size, language, and signals
function analyzeContent(response) {
  if (!response || !response.body) {
    return { score: 0, signals: ['empty_body'], isBlockPage: false };
  }

  const body = response.body;
  const bodyLower = body.toLowerCase();
  const signals = [];
  let score = 0;
  let isBlockPage = false;

  // Block page indicators
  for (const pattern of ISP_BLOCK_PATTERNS) {
    if (pattern.test(body)) {
      signals.push('isp_block_pattern');
      isBlockPage = true;
      break;
    }
  }

  // Generic block page signals
  const genericBlockSigs = [
    /access\s+(?:has\s+been\s+)?denied/i,
    /this\s+(?:web)?site\s+(?:has\s+been\s+)?(?:blocked|restricted)/i,
    /content\s+(?:has\s+been\s+)?(?:blocked|filtered|restricted)/i,
    /forbidden\s+(?:by|under)\s+(?:law|regulation)/i,
    /not\s+available\s+in\s+your\s+country/i,
    /prohibited\s+content/i,
  ];
  for (const sig of genericBlockSigs) {
    if (sig.test(body)) {
      signals.push('generic_block_signal');
      isBlockPage = true;
      break;
    }
  }

  // Title extract
  const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  if (title) {
    signals.push('has_title');
    if (/block|denied|restrict|forbidden|unavailable/i.test(title)) {
      signals.push('block_title');
      isBlockPage = true;
    } else {
      score += 30; // Real title = good sign
    }
  }

  // Body size check (block pages are typically small)
  if (body.length < 500) {
    signals.push('very_small_body');
  } else if (body.length < 2000) {
    signals.push('small_body');
  } else {
    score += 20; // Large body = real site
  }

  // HTML structure check (real sites have proper HTML)
  if (/<html[^>]*>/i.test(body) && /<\/html>/i.test(body)) {
    signals.push('valid_html');
    score += 15;
  }

  // Common real-site elements
  if (/<script|<link|<meta/i.test(body)) {
    signals.push('has_resources');
    score += 10;
  }

  // Check for redirect to known block pages
  if (response.redirectUrl) {
    const blockRedirects = ['proxy.dp.ae', 'block.du.ae', 'block.etisalat', 'blockpage', 'tdra.gov.ae', 'tra.gov.ae'];
    for (const br of blockRedirects) {
      if (response.redirectUrl.toLowerCase().includes(br)) {
        signals.push('redirect_to_block_page');
        isBlockPage = true;
        break;
      }
    }
  }

  return { score, signals, isBlockPage, title, bodySize: body.length };
}

// Single connection attempt with retry on transient errors
async function httpRequestWithRetry(url, timeout, overrideIp, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await httpRequest(url, timeout, 5, overrideIp);
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      // Only retry on transient errors
      if (!/TIMEOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH/i.test(msg)) {
        break;
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}

async function testSingleLinkDeep(entry) {
  const result = {
    ...entry,
    status: 'unknown',
    statusCode: null,
    resolvedIp: null,
    responseTime: null,
    error: null,
    ispName: null,
    verificationMode: 'deep',
    stages: {},
  };

  const startTime = Date.now();

  try {
    // ============ STAGE 1: DNS Cross-Reference ============
    let systemIp = null, dohIp = null;
    let systemDnsOk = false, dohOk = false;

    if (entry.type === 'domain') {
      // Try system DNS
      try {
        const ips = await resolveDns(entry.host);
        systemIp = ips[0];
        systemDnsOk = true;
      } catch (e) {
        result.stages.systemDnsError = e.code || e.message;
      }

      // Always cross-check with DoH
      try {
        const ips = await resolveWithDoH(entry.host);
        dohIp = ips[0];
        dohOk = true;
      } catch (e) {
        result.stages.dohError = e.message;
      }

      // Both DNS failed = domain truly does not exist
      if (!systemDnsOk && !dohOk) {
        result.status = 'down';
        result.error = 'Domain does not exist (DNS failed via system + DoH)';
        result.responseTime = Date.now() - startTime;
        return result;
      }

      result.resolvedIp = systemIp || dohIp;
      result.stages.dns = {
        systemIp,
        dohIp,
        systemDnsOk,
        dohOk,
        dnsBlocked: !systemDnsOk && dohOk, // ISP DNS failed but real DNS works
      };

      if (!systemDnsOk && dohOk) {
        result.dnsBlocked = true;
      }
    } else {
      result.resolvedIp = entry.host;
    }

    // ============ STAGE 2: TCP/HTTP via system DNS (browser perspective) ============
    const urls = buildTestUrls(entry);
    const overrideIpForDoh = result.dnsBlocked ? dohIp : null;

    // Run BOTH: system-DNS path + DoH-IP path in parallel
    const systemResults = await Promise.allSettled(
      urls.map(url => httpRequestWithRetry(url, DEEP_TIMEOUT, null, 2))
    );

    let systemResponse = null;
    let systemContentAnalysis = null;
    for (const r of systemResults) {
      if (r.status === 'fulfilled') {
        const resp = r.value;
        const analysis = analyzeContent(resp);
        if (analysis.isBlockPage) {
          systemResponse = resp;
          systemContentAnalysis = analysis;
          break;
        }
        if (resp.statusCode >= 200 && resp.statusCode < 600) {
          if (!systemResponse || (resp.statusCode < 400 && systemResponse.statusCode >= 400)) {
            systemResponse = resp;
            systemContentAnalysis = analysis;
          }
        }
      }
    }
    result.stages.systemDnsHttp = {
      reachable: !!systemResponse,
      statusCode: systemResponse?.statusCode,
      contentAnalysis: systemContentAnalysis,
    };

    // ============ STAGE 3: HTTP via DoH-resolved IP (verify reachability) ============
    let dohResponse = null;
    let dohContentAnalysis = null;
    if (overrideIpForDoh) {
      const dohResults = await Promise.allSettled(
        urls.map(url => httpRequestWithRetry(url, DEEP_TIMEOUT, overrideIpForDoh, 2))
      );
      for (const r of dohResults) {
        if (r.status === 'fulfilled') {
          const resp = r.value;
          const analysis = analyzeContent(resp);
          if (analysis.isBlockPage) {
            dohResponse = resp;
            dohContentAnalysis = analysis;
            break;
          }
          if (resp.statusCode >= 200 && resp.statusCode < 600) {
            if (!dohResponse || (resp.statusCode < 400 && dohResponse.statusCode >= 400)) {
              dohResponse = resp;
              dohContentAnalysis = analysis;
            }
          }
        }
      }
      result.stages.dohHttp = {
        reachable: !!dohResponse,
        statusCode: dohResponse?.statusCode,
        contentAnalysis: dohContentAnalysis,
      };
    }

    // ============ STAGE 4: Final Decision ============
    const responseTime = Date.now() - startTime;
    result.responseTime = responseTime;

    // PRIORITY 1: Block page detected anywhere = BLOCKED
    if (systemContentAnalysis?.isBlockPage) {
      result.status = 'isp_blocked';
      result.statusCode = systemResponse.statusCode;
      result.error = 'Block page detected via system DNS';
      const body = systemResponse.body || '';
      if (/\bdu\b|eitc|emirates.*integrated/i.test(body)) result.ispName = 'du';
      else if (/etisalat|elife/i.test(body)) result.ispName = 'Etisalat';
      else result.ispName = 'UAE ISP';
      return result;
    }
    if (dohContentAnalysis?.isBlockPage) {
      result.status = 'isp_blocked';
      result.statusCode = dohResponse.statusCode;
      result.error = 'Block page detected via DoH';
      result.ispName = 'UAE ISP';
      return result;
    }

    // PRIORITY 2: Browser perspective (system DNS) - this is what user actually sees
    if (systemResponse && systemContentAnalysis.score >= 25) {
      // Real content via system DNS = ACTIVE for sure
      result.status = 'active';
      result.statusCode = systemResponse.statusCode;
      return result;
    }

    if (!systemResponse && result.dnsBlocked && dohResponse && dohContentAnalysis?.score >= 25) {
      // System DNS blocked but DoH path works = DNS-level block (bypassable)
      result.status = 'active';
      result.statusCode = dohResponse.statusCode;
      result.dnsBlockBypassable = true;
      result.error = 'DNS blocked by ISP but site accessible (bypassable via DoH)';
      return result;
    }

    if (!systemResponse && !dohResponse) {
      // Both paths failed
      if (result.dnsBlocked) {
        result.status = 'isp_blocked';
        result.ispName = 'UAE ISP';
        result.error = 'DNS + IP both unreachable (full ISP block)';
      } else {
        result.status = 'down';
        result.error = 'Site unreachable via system DNS and DoH';
      }
      return result;
    }

    // PRIORITY 3: Got a response but content is suspicious (low score)
    // Treat as down with note - might be a server issue or content-less page
    if (systemResponse) {
      result.statusCode = systemResponse.statusCode;
      if (systemResponse.statusCode >= 400 && systemResponse.statusCode < 600) {
        result.status = 'down';
        result.error = `HTTP error ${systemResponse.statusCode}`;
      } else {
        // Got 2xx/3xx but suspicious content - mark active with low confidence
        result.status = 'active';
        result.error = `Active but content uncertain (size: ${systemContentAnalysis.bodySize}, signals: ${systemContentAnalysis.signals.join(',')})`;
      }
      return result;
    }

    // Fallback
    result.status = 'down';
    result.error = 'Could not verify';
    return result;

  } catch (err) {
    result.status = 'down';
    result.error = err.message;
    result.responseTime = Date.now() - startTime;
    return result;
  }
}

async function testLinks(entries, onProgress, mode = 'quick') {
  const results = [];
  // Deep mode uses lower concurrency (heavier per-link work)
  const concurrency = mode === 'deep' ? 8 : 15;
  let completed = 0;

  const testFn = mode === 'deep' ? testSingleLinkDeep : testSingleLink;

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(entry => testFn(entry))
    );
    results.push(...batchResults);
    completed += batch.length;

    if (onProgress) {
      onProgress(completed, entries.length);
    }
  }

  return results;
}

// "Both" mode: Run quick first, then re-verify uncertain ones with deep
async function testLinksBoth(entries, onProgress) {
  const totalSteps = entries.length * 2; // Each link tested twice in worst case
  let stepsDone = 0;

  const reportProgress = () => {
    if (onProgress) onProgress(Math.min(stepsDone, totalSteps), totalSteps);
  };

  // Phase 1: Quick test all
  const quickResults = await testLinks(entries, (done) => {
    stepsDone = done;
    reportProgress();
  }, 'quick');

  // Phase 2: Re-verify uncertain ones with deep
  // Uncertain = down (might be false negative) or any with errors
  const uncertainIndices = [];
  quickResults.forEach((r, i) => {
    if (r.status === 'down' || r.status === 'isp_blocked' || r.error) {
      uncertainIndices.push(i);
    }
  });

  if (uncertainIndices.length > 0) {
    const uncertainEntries = uncertainIndices.map(i => entries[i]);
    const concurrency = 8;
    let deepDone = 0;

    for (let i = 0; i < uncertainEntries.length; i += concurrency) {
      const batch = uncertainEntries.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(e => testSingleLinkDeep(e)));

      // Replace original quick result with deep result
      batchResults.forEach((deepResult, batchIdx) => {
        const origIdx = uncertainIndices[i + batchIdx];
        deepResult.verificationMode = 'both';
        quickResults[origIdx] = deepResult;
      });

      deepDone += batch.length;
      stepsDone = entries.length + deepDone;
      reportProgress();
    }
  }

  // Final progress
  stepsDone = totalSteps;
  reportProgress();

  return quickResults;
}

module.exports = { testLinks, testLinksBoth, testSingleLink, testSingleLinkDeep, detectCurrentISP };
