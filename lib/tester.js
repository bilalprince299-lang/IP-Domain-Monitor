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

const TIMEOUT = 8000; // 8 seconds

// --- Auto Detect Current ISP ---
function detectCurrentISP() {
  try {
    // Method 1: Check DNS servers
    const resolverConfig = execSync('scutil --dns 2>/dev/null || cat /etc/resolv.conf 2>/dev/null', { encoding: 'utf8', timeout: 3000 });

    // Etisalat DNS servers
    const etisalatDns = ['213.42.', '195.229.', '94.200.'];
    // du DNS servers
    const duDns = ['213.210.', '94.203.', '91.83.'];

    for (const dns of etisalatDns) {
      if (resolverConfig.includes(dns)) return { isp: 'Etisalat', method: 'dns' };
    }
    for (const dns of duDns) {
      if (resolverConfig.includes(dns)) return { isp: 'du', method: 'dns' };
    }

    // Method 2: Check default gateway IP ranges
    const networkInterfaces = os.networkInterfaces();
    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
      for (const iface of interfaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const ip = iface.address;
          // Etisalat common ranges
          if (ip.startsWith('10.') || ip.startsWith('213.42.') || ip.startsWith('94.200.') || ip.startsWith('195.229.')) {
            // Could be Etisalat
          }
        }
      }
    }

    // Method 3: HTTP check to known endpoint
    return detectISPviaHTTP();
  } catch (err) {
    return { isp: 'Unknown', method: 'error', error: err.message };
  }
}

async function detectISPviaHTTP() {
  return new Promise((resolve) => {
    const req = http.get('http://whatismyip.akamai.com/', { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const publicIp = body.trim();
        // Etisalat IP ranges
        if (publicIp.startsWith('213.42.') || publicIp.startsWith('94.200.') || publicIp.startsWith('195.229.') || publicIp.startsWith('86.96.') || publicIp.startsWith('86.97.')) {
          resolve({ isp: 'Etisalat', method: 'ip', publicIp });
        }
        // du IP ranges
        else if (publicIp.startsWith('213.210.') || publicIp.startsWith('94.203.') || publicIp.startsWith('91.83.') || publicIp.startsWith('5.30.') || publicIp.startsWith('5.31.')) {
          resolve({ isp: 'du', method: 'ip', publicIp });
        }
        else {
          resolve({ isp: 'Unknown', method: 'ip', publicIp });
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

function httpRequest(url, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      rejectUnauthorized: false, // Allow self-signed certs
    };

    const req = client.request(options, (res) => {
      let body = '';
      const maxBody = 50000; // Read max 50KB

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
    // Resolve DNS for domains
    if (entry.type === 'domain') {
      try {
        const ips = await resolveDns(entry.host);
        result.resolvedIp = ips[0];
      } catch (dnsErr) {
        result.status = 'down';
        result.error = `DNS resolution failed: ${dnsErr.code || dnsErr.message}`;
        result.responseTime = Date.now() - startTime;
        return result;
      }
    }

    // Build test URLs
    const urls = buildTestUrls(entry);

    // Try each URL
    let lastError = null;
    for (const url of urls) {
      try {
        const response = await httpRequest(url);
        result.statusCode = response.statusCode;
        result.responseTime = Date.now() - startTime;

        // Check for ISP block
        if (isIspBlocked(response)) {
          result.status = 'isp_blocked';
          // Try to detect which ISP
          if (/etisalat|elife/i.test(response.body)) {
            result.ispName = 'Etisalat';
          } else if (/\bdu\b|eitc/i.test(response.body)) {
            result.ispName = 'du';
          } else {
            result.ispName = 'UAE ISP';
          }
          return result;
        }

        // Check if redirect to block page
        if (response.statusCode >= 301 && response.statusCode <= 308 && response.redirectUrl) {
          try {
            const redirectResponse = await httpRequest(response.redirectUrl);
            if (isIspBlocked(redirectResponse)) {
              result.status = 'isp_blocked';
              result.ispName = 'UAE ISP';
              return result;
            }
          } catch (e) {
            // Redirect follow failed, not necessarily blocked
          }
        }

        // Active if we got a response
        if (response.statusCode >= 200 && response.statusCode < 500) {
          result.status = 'active';
          return result;
        }

        lastError = `HTTP ${response.statusCode}`;
      } catch (err) {
        lastError = err.message;
      }
    }

    // All URLs failed
    result.status = 'down';
    result.error = lastError;
    result.responseTime = Date.now() - startTime;

  } catch (err) {
    result.status = 'down';
    result.error = err.message;
    result.responseTime = Date.now() - startTime;
  }

  return result;
}

function buildTestUrls(entry) {
  const urls = [];

  if (entry.port) {
    // Specific port given - test with that port
    urls.push(`${entry.protocol}://${entry.host}:${entry.port}/`);
  } else {
    // No port - test both HTTP 80 and HTTPS 443
    urls.push(`http://${entry.host}:80/`);
    urls.push(`https://${entry.host}:443/`);
  }

  return urls;
}

async function testLinks(entries, onProgress) {
  const results = [];
  const concurrency = 10; // Test 10 at a time
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
