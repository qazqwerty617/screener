"use strict";

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║        OBSIDIAN SMART ADAPTIVE SECURITY SHIELD & ANTI-DDOS (v2.0)        ║
 * ║   Multi-User Friendly • Strike-Based Bot Defense • Soft 429 Throttling   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Designed for high-frequency crypto trading environments. Supports shared
 * office IPs, mobile carrier CGNAT, multi-tab traders, and high websocket volume.
 *
 * Rules:
 * 1. Multi-Tab & Shared IP: Up to 50 concurrent WebSockets per IP (5+ users x 10 tabs).
 * 2. High Request Ceiling: 150 req/3s burst, 600 req/min for fast screener updates.
 * 3. Soft Throttling (HTTP 429) before any kernel ban.
 * 4. Strike System: 5 aggressive malicious attempts required before kernel ban.
 * 5. Safe Testing: No Telegram alerts fired in test/local environments.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execSync, exec } = require("child_process");

const BANNED_IPS_FILE = path.join(__dirname, "security_banned_ips.json");

// ═══ Global In-Memory Security State ══════════════════════════════════════════
const bannedIpsMap = new Map();       // ip -> { reason, bannedAt, expiresAt, hits }
const requestRateMap = new Map();     // ip -> Array<timestamp>
const strikeCountMap = new Map();     // ip -> { strikes: number, lastStrike: number }
const wsConnectionsPerIp = new Map(); // ip -> count
const lastTelegramAlertMap = new Map(); // ip -> timestamp

// ═══ Configurable Thresholds ═════════════════════════════════════════════════
const LIMITS = {
  MAX_CONCURRENT_WS_PER_IP: 50,      // Accommodates 5-10 users or heavy multi-tab usage
  BURST_REQ_PER_3S: 150,             // Fast screener polling
  BURST_REQ_PER_60S: 800,            // Normal heavy usage
  VOLUMETRIC_DDOS_THRESHOLD: 300,    // 300 req / 3s triggers kernel drop
  STRIKES_FOR_BAN: 5,                // 5 strikes needed to ban
  STRIKE_EXPIRY_MS: 60 * 1000,       // Strikes decay after 60s
  DEFAULT_BAN_DURATION_SEC: 1800,    // 30 minutes for automated bans
  TELEGRAM_ALERT_THROTTLE_MS: 10 * 60 * 1000 // Max 1 alert per 10m
};

// ═══ Hard Exploit Scanner Signatures (High Confidence Exploits Only) ═════════
const EXPLOIT_PATTERNS = [
  /(\.\.[\/\\])/i,                                             // Path traversal (../ or ..\)
  /(\/etc\/(passwd|shadow|hosts|group))/i,                     // Linux credential probing
  /(\.(env|git|aws|ssh|backup))(\/|$|\?)/i,                    // Sensitive secret scraping
  /(wp-login|wp-admin|phpmyadmin|pma|cgi-bin|eval-stdin|boaform|setup\.cgi)/i, // Bot scanner endpoints
  /(union\s+select\s+|benchmark\(\d+,|waitfor\s+delay\s+)/i    // Active SQL injection probes
];

// ═══ Trusted Whitelist (Never Ban) ════════════════════════════════════════════
const WHITELISTED_IPS = new Set([
  "127.0.0.1",
  "::1",
  "localhost"
]);

function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  const cleanIp = ip.replace(/^::ffff:/, "").trim();
  if (WHITELISTED_IPS.has(cleanIp)) return true;
  if (cleanIp.startsWith("10.") || cleanIp.startsWith("192.168.")) return true;
  if (cleanIp.startsWith("172.")) {
    const secondOctet = parseInt(cleanIp.split(".")[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

// ═══ Safe Execution Helper ════════════════════════════════════════════════════
// `execSync` was previously called from `banIp`, i.e. **from inside the request
// path** whenever a volumetric flood tripped the threshold. Spawning a child
// process synchronously blocks the entire event loop — exactly the wrong thing to
// do while under a flood. All firewall mutations are now fire-and-forget async.
function runIptablesCmd(cmd) {
  if (os.platform() !== "linux") return false;
  exec(cmd, { encoding: "utf8", timeout: 4000 }, () => {});
  return true;
}

function runIptablesCmdSync(cmd) {
  if (os.platform() !== "linux") return false;
  try {
    execSync(cmd, { encoding: "utf8", timeout: 4000, stdio: "pipe" });
    return true;
  } catch (_) {
    return false;
  }
}

// ═══ Telegram Security Alert Dispatcher (Throttled & Non-Intrusive) ═══════════
function sendSecurityAlert(text, ip = "") {
  // Never send Telegram alerts in test mode
  if (process.env.NODE_ENV === "test" || process.argv.includes("test")) return;

  // Throttle alerts for the same IP
  if (ip) {
    const lastAlert = lastTelegramAlertMap.get(ip) || 0;
    if (Date.now() - lastAlert < LIMITS.TELEGRAM_ALERT_THROTTLE_MS) return;
    if (lastTelegramAlertMap.size >= MAX_TRACKED_IPS) {
      evictOldestHalf(lastTelegramAlertMap, (ts) => ts);
    }
    lastTelegramAlertMap.set(ip, Date.now());
  }

  const token = (process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.ADMIN_CHAT_ID || "").trim();
  if (!token || !chatId) return;

  try {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 4000
      },
      (res) => { res.resume(); }
    );
    req.on("error", () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

// ═══ Persistence Manager ══════════════════════════════════════════════════════
function loadBannedIpsFromDisk() {
  if (!fs.existsSync(BANNED_IPS_FILE)) return;
  try {
    const raw = fs.readFileSync(BANNED_IPS_FILE, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [ip, info] of Object.entries(data)) {
      if (info && info.expiresAt > now) {
        bannedIpsMap.set(ip, info);
      }
    }
  } catch (_) {}
}

function saveBannedIpsToDisk() {
  // Debounced + async: this used to be a blocking `writeFileSync` called from
  // `banIp`, which itself runs on the request path during a flood.
  if (savePending) { saveAgain = true; return; }
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flushBannedIps, 250);
  saveTimer.unref?.();
}

let savePending = false;
let saveAgain = false;
let saveTimer = null;

function serializeBans() {
  const obj = {};
  for (const [ip, info] of bannedIpsMap.entries()) obj[ip] = info;
  return JSON.stringify(obj, null, 2);
}

function flushBannedIps() {
  saveTimer = null;
  let json;
  try { json = serializeBans(); } catch (_) { savePending = false; return; }
  fs.writeFile(BANNED_IPS_FILE, json, "utf8", () => {
    savePending = false;
    if (saveAgain) {
      saveAgain = false;
      saveBannedIpsToDisk();
    }
  });
}

// A crash-time flush so a ban survives a restart even if it was issued <250 ms ago.
process.once("exit", () => {
  if (!savePending) return;
  try { fs.writeFileSync(BANNED_IPS_FILE, serializeBans(), "utf8"); } catch (_) {}
});

// ═══ Kernel iptables Firewall Chain Setup ═════════════════════════════════════
// Only this runs synchronously, and only once at module load, where blocking is
// harmless (nothing is being served yet) and ordering matters: the chain has to
// exist before rules are inserted into it.
function initKernelFirewallChain() {
  if (os.platform() !== "linux") return;
  try {
    runIptablesCmdSync("iptables -N OBSIDIAN_SHIELD 2>/dev/null || true");
    const inputRules = execSync("iptables -L INPUT -n 2>/dev/null", { encoding: "utf8", timeout: 4000 });
    if (!inputRules.includes("OBSIDIAN_SHIELD")) {
      runIptablesCmdSync("iptables -I INPUT 1 -j OBSIDIAN_SHIELD");
    }

    // Sync only genuinely unexpired active bans
    for (const [ip, info] of bannedIpsMap.entries()) {
      if (info.expiresAt > Date.now()) {
        runIptablesCmdSync(`iptables -I OBSIDIAN_SHIELD 1 -s ${ip} -j DROP 2>/dev/null || true`);
      }
    }
  } catch (_) {}
}

// ═══ Strike Recording System ══════════════════════════════════════════════════
function recordStrike(ip, reason) {
  const cleanIp = ip.replace(/^::ffff:/, "").trim();
  if (isPrivateOrLocalIp(cleanIp)) return false;

  const now = Date.now();
  let entry = strikeCountMap.get(cleanIp);
  if (!entry || now - entry.lastStrike > LIMITS.STRIKE_EXPIRY_MS) {
    entry = { strikes: 0, lastStrike: now };
  }

  entry.strikes += 1;
  entry.lastStrike = now;
  if (!strikeCountMap.has(cleanIp) && strikeCountMap.size >= MAX_TRACKED_IPS) {
    evictOldestHalf(strikeCountMap, (e) => e.lastStrike);
  }
  strikeCountMap.set(cleanIp, entry);

  if (entry.strikes >= LIMITS.STRIKES_FOR_BAN) {
    banIp(cleanIp, `Repeated Violations (${entry.strikes} strikes: ${reason})`, LIMITS.DEFAULT_BAN_DURATION_SEC);
    strikeCountMap.delete(cleanIp);
    return true; // Banned
  }

  return false; // Striked but not banned yet
}

// ═══ Ban & Unban Actions ══════════════════════════════════════════════════════
function banIp(ip, reason = "Excessive traffic / Malicious activity", durationSeconds = LIMITS.DEFAULT_BAN_DURATION_SEC) {
  if (!ip) return false;
  const cleanIp = ip.replace(/^::ffff:/, "").trim();
  if (isPrivateOrLocalIp(cleanIp)) return false;

  const now = Date.now();
  const expiresAt = now + (durationSeconds * 1000);
  const existing = bannedIpsMap.get(cleanIp);
  const hits = existing ? existing.hits + 1 : 1;

  bannedIpsMap.set(cleanIp, {
    reason,
    bannedAt: now,
    expiresAt,
    hits
  });

  saveBannedIpsToDisk();

  // Execute kernel block via iptables on Linux
  if (os.platform() === "linux") {
    runIptablesCmd(`iptables -I OBSIDIAN_SHIELD 1 -s ${cleanIp} -j DROP 2>/dev/null || true`);
  }

  const durationStr = durationSeconds >= 86400 
    ? `${Math.round(durationSeconds / 86400)} дн.` 
    : `${Math.round(durationSeconds / 60)} мин.`;

  sendSecurityAlert(
    `🛡️ <b>[SECURITY SHIELD: IP BANNED]</b>\n` +
    `• <b>IP:</b> <code>${cleanIp}</code>\n` +
    `• <b>Причина:</b> <code>${reason}</code>\n` +
    `• <b>Срок блокировки:</b> <code>${durationStr}</code>\n` +
    `• <b>Метод:</b> <code>iptables KERNEL DROP</code>\n` +
    `• <b>Всего заблокировано:</b> <code>${bannedIpsMap.size}</code>`,
    cleanIp
  );

  return true;
}

function unbanIp(ip) {
  if (!ip) return false;
  const cleanIp = ip.replace(/^::ffff:/, "").trim();
  if (!bannedIpsMap.has(cleanIp)) return false;

  bannedIpsMap.delete(cleanIp);
  strikeCountMap.delete(cleanIp);
  saveBannedIpsToDisk();

  if (os.platform() === "linux") {
    runIptablesCmd(`iptables -D OBSIDIAN_SHIELD -s ${cleanIp} -j DROP 2>/dev/null || true`);
  }

  return true;
}

function clearAllBans() {
  const count = bannedIpsMap.size;
  bannedIpsMap.clear();
  strikeCountMap.clear();
  saveBannedIpsToDisk();

  if (os.platform() === "linux") {
    runIptablesCmd("iptables -F OBSIDIAN_SHIELD 2>/dev/null || true");
  }
  return count;
}

function isIpBanned(ip) {
  if (!ip) return false;
  const cleanIp = ip.replace(/^::ffff:/, "").trim();
  const banInfo = bannedIpsMap.get(cleanIp);
  if (!banInfo) return false;

  if (Date.now() > banInfo.expiresAt) {
    unbanIp(cleanIp);
    return false;
  }
  return true;
}

// Auto-unban background maintenance sweep + eviction of dead per-IP state.
//
// `requestRateMap`, `strikeCountMap` and `lastTelegramAlertMap` are keyed by
// source IP and were **never** pruned — one Map entry per distinct client IP,
// retained for the whole process lifetime. That is the classic per-IP-map leak
// and it is trivially amplified by a rotating-source-IP flood, which is exactly
// the traffic this module exists to survive.
const RATE_KEY_TTL_MS = 120000;          // 2x the 60s sliding window
const STRIKE_KEY_TTL_MS = LIMITS.STRIKE_EXPIRY_MS * 4;
const ALERT_KEY_TTL_MS = LIMITS.TELEGRAM_ALERT_THROTTLE_MS * 2;
// Hard ceilings so a burst between sweeps cannot exhaust the heap either.
const MAX_TRACKED_IPS = 50000;

function pruneIpState(now) {
  for (const [ip, timestamps] of requestRateMap) {
    // The middleware always leaves the newest timestamp last.
    if (!timestamps.length || now - timestamps[timestamps.length - 1] > RATE_KEY_TTL_MS) {
      requestRateMap.delete(ip);
    }
  }
  for (const [ip, entry] of strikeCountMap) {
    if (now - entry.lastStrike > STRIKE_KEY_TTL_MS) strikeCountMap.delete(ip);
  }
  for (const [ip, ts] of lastTelegramAlertMap) {
    if (now - ts > ALERT_KEY_TTL_MS) lastTelegramAlertMap.delete(ip);
  }
}

/** Emergency eviction: drop the oldest half when a map blows past its ceiling. */
function evictOldestHalf(map, tsOf) {
  const entries = Array.from(map.entries());
  entries.sort((a, b) => tsOf(a[1]) - tsOf(b[1]));
  const drop = entries.length >> 1;
  for (let i = 0; i < drop; i++) map.delete(entries[i][0]);
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, info] of bannedIpsMap.entries()) {
    if (now > info.expiresAt) {
      unbanIp(ip);
    }
  }
  pruneIpState(now);
}, 60000);
if (cleanupTimer && typeof cleanupTimer.unref === "function") {
  cleanupTimer.unref();
}

// ═══ Express & HTTP Request Inspector Middleware ══════════════════════════════
function securityShieldMiddleware(req, res, next) {
  const rawIp = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "";
  const cleanIp = rawIp.replace(/^::ffff:/, "").trim();

  // 1. Immediate drop if IP is explicitly banned
  if (isIpBanned(cleanIp)) {
    res.setHeader("Connection", "close");
    return res.status(403).send("Forbidden (Access Denied by Security Shield)");
  }

  if (isPrivateOrLocalIp(cleanIp)) {
    return next();
  }

  // A malformed percent-sequence (`GET /%E0%A4%A`) makes decodeURIComponent
  // throw URIError. Unguarded, that threw out of the *first* middleware on every
  // request and surfaced as a 500 — trivially triggerable by any scanner.
  const rawTarget = req.originalUrl || req.url || "";
  let rawUrl;
  try {
    rawUrl = decodeURIComponent(rawTarget);
  } catch (_) {
    rawUrl = rawTarget;
  }

  // 2. Strike-Based Scanner Defense (requires repeated bot attempts)
  for (const pattern of EXPLOIT_PATTERNS) {
    if (pattern.test(rawUrl)) {
      const isBanned = recordStrike(cleanIp, `Probing ${rawUrl.slice(0, 40)}`);
      res.setHeader("Connection", "close");
      return res.status(403).send(isBanned ? "Forbidden (IP Banned)" : "Forbidden (Access Denied)");
    }
  }

  // 3. Adaptive Rate Limiter (Soft 429 first, Kernel drop only on extreme volumetric DDoS)
  //
  // The old implementation rebuilt the whole timestamp array with `.filter()` on
  // every request and then ran a *second* `.filter()` to count the 3s window —
  // two O(n) passes plus a fresh array allocation per request, per IP, at up to
  // 800 retained timestamps. Timestamps are monotonically increasing, so a single
  // in-place trim from the front and a backwards count are enough.
  const now = Date.now();
  let timestamps = requestRateMap.get(cleanIp);
  if (!timestamps) {
    if (requestRateMap.size >= MAX_TRACKED_IPS) {
      pruneIpState(now);
      if (requestRateMap.size >= MAX_TRACKED_IPS) {
        evictOldestHalf(requestRateMap, (arr) => (arr.length ? arr[arr.length - 1] : 0));
      }
    }
    timestamps = [];
    requestRateMap.set(cleanIp, timestamps);
  }

  // Drop everything outside the 1-minute sliding window.
  let firstFresh = 0;
  while (firstFresh < timestamps.length && now - timestamps[firstFresh] >= 60000) firstFresh++;
  if (firstFresh > 0) timestamps.splice(0, firstFresh);
  timestamps.push(now);

  // Count the last 3 seconds walking backwards from the newest entry.
  let reqsLast3s = 0;
  for (let i = timestamps.length - 1; i >= 0 && now - timestamps[i] < 3000; i--) reqsLast3s++;

  // Extreme Volumetric Flood -> Kernel Ban
  if (reqsLast3s > LIMITS.VOLUMETRIC_DDOS_THRESHOLD) {
    banIp(cleanIp, `Volumetric HTTP DDoS (${reqsLast3s} req/3s)`, LIMITS.DEFAULT_BAN_DURATION_SEC);
    res.setHeader("Connection", "close");
    return res.status(429).send("Too Many Requests (Banned by Security Shield)");
  }

  // Normal High Rate -> Soft 429 Throttle (No IP Ban!)
  if (reqsLast3s > LIMITS.BURST_REQ_PER_3S || timestamps.length > LIMITS.BURST_REQ_PER_60S) {
    res.setHeader("Retry-After", "5");
    return res.status(429).json({ error: "Слишком много запросов. Подождите пару секунд.", retryAfter: 5 });
  }

  next();
}

// ═══ Multi-User & Multi-Tab WebSocket Connection Guard ════════════════════════
function registerWsConnection(ip) {
  const cleanIp = (ip || "").replace(/^::ffff:/, "").trim();
  if (isPrivateOrLocalIp(cleanIp)) return true;

  if (isIpBanned(cleanIp)) return false;

  const currentCount = wsConnectionsPerIp.get(cleanIp) || 0;
  // Tolerates up to 50 active tabs/connections from the same IP (office / mobile carrier)
  if (currentCount >= LIMITS.MAX_CONCURRENT_WS_PER_IP) {
    recordStrike(cleanIp, `WS Limit Exceeded (${currentCount} sockets)`);
    return false;
  }

  wsConnectionsPerIp.set(cleanIp, currentCount + 1);
  return true;
}

function unregisterWsConnection(ip) {
  const cleanIp = (ip || "").replace(/^::ffff:/, "").trim();
  const currentCount = wsConnectionsPerIp.get(cleanIp) || 0;
  if (currentCount <= 1) {
    wsConnectionsPerIp.delete(cleanIp);
  } else {
    wsConnectionsPerIp.set(cleanIp, currentCount - 1);
  }
}

// ═══ Initializer ══════════════════════════════════════════════════════════════
loadBannedIpsFromDisk();
initKernelFirewallChain();

module.exports = {
  LIMITS,
  banIp,
  unbanIp,
  clearAllBans,
  isIpBanned,
  recordStrike,
  securityShieldMiddleware,
  registerWsConnection,
  unregisterWsConnection,
  initKernelFirewallChain,
  getBannedIpsList: () => Array.from(bannedIpsMap.entries()).map(([ip, info]) => ({ ip, ...info })),
  isPrivateOrLocalIp
};
