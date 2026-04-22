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

async function testLinks(entries, onProgress) {
  const results = [];
  const concurrency = 15; // Test 15 at a time (parallel HTTP/HTTPS)
  let completed = 0;

  // Process in batches
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(entry => testSingleLink(entry))
    );
    results.push(...batchResults);
    completed += batch.length;

    if (onProgress) {
      onProgress(completed, entries.length);
    }
  }

  return results;
}

module.exports = { testLinks, testSingleLink, detectCurrentISP };
