"use strict";
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");

const denied = new net.BlockList();
const denied6 = new net.BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]]) denied.addSubnet(ip, bits);
for (const [ip, bits] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) denied6.addSubnet(ip, bits, "ipv6");
const isPublicAddress = ip => net.isIP(ip) === 4 ? !denied.check(ip, "ipv4") : net.isIP(ip) === 6 && !denied6.check(ip, "ipv6");

// Pin the validated address in the actual socket lookup (DNS rebinding safe).
// No credentials follow redirects, and website redirects stay on the same host
// with only a www alias allowed. Catalog URLs cannot reach local services.
function readSocialUrl(raw, { headers = {}, signal, maxBytes = 2_000_000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
        net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Unsafe source URL");
    } catch (e) { reject(e); return; }
    const controller = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
    const req = https.get(url, { signal: controller, headers: { "User-Agent": "ObsidianScreener/1.0", Accept: "text/html,application/json", ...headers },
      lookup(host, options, callback) {
        dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return callback(new Error("Non-public source address"));
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        try {
          const target = new URL(res.headers.location, url);
          if (redirects <= 0 || headers.Authorization || target.hostname.replace(/^www\./, "") !== url.hostname.replace(/^www\./, "")) throw new Error("Unverified redirect");
          resolve(readSocialUrl(target.href, { headers, signal: controller, maxBytes, redirects: redirects - 1 }));
        } catch (e) { reject(e); }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const error = new Error(`HTTP ${res.statusCode}`); error.status = res.statusCode;
        const seconds = Number(res.headers["retry-after"]), reset = Number(res.headers["x-rate-limit-reset"]) * 1000;
        error.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, reset - Date.now()) || 0;
        reject(error); return;
      }
      let size = 0; const chunks = [];
      res.on("data", chunk => { size += chunk.length; if (size > maxBytes) res.destroy(new Error("Source too large")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
  });
}
module.exports = { readSocialUrl, isPublicAddress };
