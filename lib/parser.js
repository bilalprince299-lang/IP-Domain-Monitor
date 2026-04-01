/**
 * Link Parser - Extracts domains, IPs, and ports from bulk text
 */

// Match IP addresses (IPv4)
const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/;

function parseLinks(text) {
  if (!text || !text.trim()) return [];

  const results = [];
  const seen = new Set();
  const lines = text.split(/[\n\r]+/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to extract URLs/links from this line
    const extracted = extractFromLine(trimmed);
    for (const entry of extracted) {
      const key = `${entry.host}:${entry.port || 'default'}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(entry);
      }
    }
  }

  return results;
}

function extractFromLine(line) {
  const results = [];

  // Pattern 1: Full URLs like http://1.2.3.4:8080/path or http://domain.com:8880/path
  const urlRegex = /https?:\/\/([^\s\/:,;]+)(?::(\d+))?(\/[^\s,;]*)?/gi;
  let match;

  while ((match = urlRegex.exec(line)) !== null) {
    const host = match[1];
    const port = match[2] ? parseInt(match[2]) : null;
    const protocol = match[0].toLowerCase().startsWith('https') ? 'https' : 'http';
    const originalUrl = match[0];

    results.push({
      original: originalUrl,
      host: host,
      port: port,
      protocol: protocol,
      type: IPV4_REGEX.test(host) ? 'ip' : 'domain'
    });
  }

  // If we found URLs, return them
  if (results.length > 0) return results;

  // Pattern 2: IP:Port without protocol (e.g., 192.168.1.1:8080)
  const ipPortRegex = /\b((?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)):(\d+)\b/g;
  while ((match = ipPortRegex.exec(line)) !== null) {
    results.push({
      original: match[0],
      host: match[1],
      port: parseInt(match[2]),
      protocol: 'http',
      type: 'ip'
    });
  }

  if (results.length > 0) return results;

  // Pattern 3: Bare IP address (e.g., 192.168.1.1)
  const bareIpRegex = /\b((?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))\b/g;
  while ((match = bareIpRegex.exec(line)) !== null) {
    results.push({
      original: match[0],
      host: match[1],
      port: null,
      protocol: 'http',
      type: 'ip'
    });
  }

  if (results.length > 0) return results;

  // Pattern 4: Domain with port (e.g., example.com:8080)
  const domainPortRegex = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}):(\d+)\b/g;
  while ((match = domainPortRegex.exec(line)) !== null) {
    results.push({
      original: match[0],
      host: match[1],
      port: parseInt(match[2]),
      protocol: 'http',
      type: 'domain'
    });
  }

  if (results.length > 0) return results;

  // Pattern 5: Bare domain (e.g., example.com)
  const bareDomainRegex = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})\b/g;
  while ((match = bareDomainRegex.exec(line)) !== null) {
    results.push({
      original: match[0],
      host: match[1],
      port: null,
      protocol: 'http',
      type: 'domain'
    });
  }

  return results;
}

module.exports = { parseLinks };
