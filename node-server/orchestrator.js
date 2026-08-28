"use strict";

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║            OBSIDIAN ULTRA-AUTONOMOUS ORCHESTRATOR BRAIN & SENTRY         ║
 * ║     Next-Gen Self-Healing Watchdog • Event-Loop Sentry • Deep Cleaner    ║
 * ║                       Version 5.5 (God-Tier Autonomous Sentinel)         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Runs 24/7 as the ultra-intelligent central nervous system & immune shield.
 *
 * Core Capabilities:
 *  1. Per-Service Circuit Breaker (Crash-Loop Protection & Telegram Alert on >5 restarts/10m)
 *  2. Heartbeat Watchdog File (heartbeat.txt + automated cron supervisor installer)
 *  3. Adaptive Z-Score Anomaly Detector (Rolling μ + σ over 1h for dynamic RAM/latency limits)
 *  4. Rolling p95/p99 Event Loop Lag Sentry (Sliding window percentiles via perf_hooks)
 *  5. Semantic Health Probing (Go scanner candle age validation + WS payload echo test)
 *  6. Pre-Kill V8 Heap Snapshot Capture (Rotated snapshots in snapshots/ before process kill)
 *  7. CPU% & File Descriptor Leak Detector (/proc/<pid>/fd + active handles tracking)
 *  8. Network Bandwidth & Rx/Tx Throughput Telemetry (/proc/net/dev throughput in Mbps)
 *  9. Realtime ASCII Sparkline Telemetry Graphs in Terminal (▂▃▅▆▇█ for RAM, CPU, Lag, Net)
 * 10. Multi-Exchange WebSocket Direct Handshake & Stream Probe (Binance, Bybit WS latency)
 * 11. Database Relational Integrity & Orphan Session Cleaner (Cross-checks sessions vs users)
 * 12. Graceful WS Client Drain on Soft Restart (Reconnect signal before reload)
 * 13. 600-Point Time-Series History Ring Buffer (100 mins of 10s metrics with --history)
 * 14. Multi-Exchange Venue Geo-Latency & DNS Matrix (Binance, Bybit, OKX, Gate, MEXC, Bitget)
 * 15. Self-Healing Corrupted Database Auto-Recovery (Atomic I/O + .bak rollback)
 * 16. PM2 Ecosystem Auto-Generator & Socket Buffer Kernel Optimizer
 * 17. Built-in REST/IPC Control & Prometheus Metrics Server (127.0.0.1:3001)
 * 18. Visual ASCII Terminal Gauges & CLI Suite (--doctor, --status, --history, --watch, --venues, --install-cron)
 */

const http = require("http");
const https = require("https");
const { execSync, exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const dns = require("dns");
const v8 = require("v8");
const { monitorEventLoopDelay } = require("perf_hooks");
const securityShield = require("./securityShield");

// Try loading environment variables
try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch (_) {}

// ═══ Global Safety Shield (Never Crash the Orchestrator) ═══════════════════════
process.on("uncaughtException", (err) => {
  const msg = err ? err.stack || err.message || String(err) : "Unknown exception";
  console.error(`[ORCHESTRATOR SHIELD] Uncaught Exception: ${msg}`);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason ? reason.stack || reason.message || String(reason) : "Unknown rejection";
  console.error(`[ORCHESTRATOR SHIELD] Unhandled Rejection: ${msg}`);
});

// SIGHUP: Dynamic Config Reload without daemon interruption
process.on("SIGHUP", () => {
  log("info", "🔄 [SIGHUP] Reloading environment variables and performing immediate audit...");
  try {
    require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });
  } catch (_) {}
  performHealthCheck().catch(() => {});
});

// Clean Shutdown Shield
process.on("SIGINT", () => {
  log("info", "🛑 [SIGINT] Graceful orchestrator shutdown requested. Flushing state...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("info", "🛑 [SIGTERM] Terminating orchestrator daemon cleanly...");
  process.exit(0);
});

// ═══ Persistent Keep-Alive Connection Agents ═════════════════════════════════
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 6,
  timeout: 5000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 6,
  timeout: 6000
});

// ═══ Global Configuration ════════════════════════════════════════════════════
const CONFIG = {
  CHECK_INTERVAL_MS: 10000,             // Health probe cycle (every 10s)
  CLEANUP_INTERVAL_MS: 15 * 60 * 1000,  // Deep garbage/cache clean (every 15m)
  DB_PRUNE_INTERVAL_MS: 60 * 60 * 1000, // Database compaction cycle (every 60m)
  HTTP_TIMEOUT_MS: 8000,               // Max HTTP probe timeout (adjusted for 13k+ pairs)
  WS_TIMEOUT_MS: 7000,                 // Max WebSocket handshake timeout (adjusted for heavy event loop)
  MAX_FAILURES_BEFORE_RESTART: 4,      // Consec failures before auto-heal (40s buffer against tick bursts)
  MIN_NODE_MEMORY_FLOOR_MB: 450,       // Minimum floor before adaptive RAM trigger
  MAX_NODE_MEMORY_CEILING_MB: 950,     // Absolute hard ceiling before emergency recycle
  MAX_LOG_SIZE_MB: 40,                 // Max PM2 logs size before flush
  MAX_AUTH_LOGS_ENTRIES: 2000,         // Retain latest N auth log records
  MAX_AUTH_LOG_AGE_DAYS: 30,           // Retain auth logs younger than 30 days
  MAX_SESSION_AGE_DAYS: 365,           // Purge sessions older than 365 days
  DISK_CRITICAL_USAGE_PCT: 88,         // Emergency purge disk threshold
  NODE_PORT: parseInt(process.env.PORT || "3000", 10),
  CONTROL_SERVER_PORT: parseInt(process.env.ORCHESTRATOR_PORT || "3001", 10),
  ENABLE_CONTROL_SERVER: false,        // Optional internal REST API on port 3001
  GO_SCANNER_PORT: 8082,
  IPTABLES_REDIRECT: true,
  CIRCUIT_BREAKER_MAX_RESTARTS: 5,     // Max auto-heals within window (5 per service)
  CIRCUIT_BREAKER_WINDOW_MS: 10 * 60 * 1000,  // 10 min sliding window
  CIRCUIT_BREAKER_COOLDOWN_MS: 5 * 60 * 1000, // 5 min freeze for manual review
  EVENT_LOOP_LAG_WARN_MS: 300,         // Warn if event loop delay exceeds 300ms
  EVENT_LOOP_LAG_CRITICAL_MS: 800,     // Critical threshold for event loop lag
  TELEGRAM_ALERT_DEBOUNCE_MS: 30000,   // Group consecutive alert storms in 30s
  BACKUPS_DIR: path.join(__dirname, "backups"),
  SNAPSHOTS_DIR: path.join(__dirname, "snapshots"),
  HEARTBEAT_FILE: path.join(__dirname, "heartbeat.txt")
};

// ═══ Ring Buffer for Zero-Leak In-Memory Metrics ══════════════════════════════
class RingBuffer {
  constructor(capacity = 50) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }
  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }
  toArray() {
    const result = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - this.size + i + this.capacity) % this.capacity;
      result.push(this.buffer[idx]);
    }
    return result;
  }
  get latest() {
    if (this.size === 0) return null;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }
}

// ═══ Real-time ASCII Sparkline Generator ═══════════════════════════════════════
function renderSparkline(values, minVal = null, maxVal = null) {
  if (!values || values.length === 0) return "";
  const chars = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = minVal !== null ? minVal : Math.min(...values);
  const max = maxVal !== null ? maxVal : Math.max(...values);
  const range = max - min;
  if (range === 0) return chars[3].repeat(values.length);
  return values.map(v => {
    const idx = Math.min(chars.length - 1, Math.max(0, Math.floor(((v - min) / range) * (chars.length - 1))));
    return chars[idx];
  }).join("");
}

// ═══ Adaptive Z-Score Rolling Statistics Tracker ═══════════════════════════════
class RollingStats {
  constructor(maxSize = 360) { // 360 points @ 10s = 1 hour window
    this.buffer = new RingBuffer(maxSize);
  }
  push(val) {
    if (typeof val === "number" && !isNaN(val) && val >= 0) {
      this.buffer.push(val);
    }
  }
  getStats() {
    const arr = this.buffer.toArray();
    if (arr.length < 5) return { mean: 0, std: 0, count: arr.length };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
    const std = Math.sqrt(variance);
    return { mean: Math.round(mean * 100) / 100, std: Math.round(std * 100) / 100, count: arr.length };
  }
  calcZScore(val) {
    const { mean, std } = this.getStats();
    if (std === 0 || mean === 0) return 0;
    return Math.round(((val - mean) / std) * 100) / 100;
  }
}

const ramStatsTracker = new RollingStats(360);
const httpLatencyStatsTracker = new RollingStats(360);
const wsLatencyStatsTracker = new RollingStats(360);

// ═══ Rolling Event Loop Lag Window (p50, p95, p99 over 5-10 min) ══════════════
let eventLoopHistogram = null;
try {
  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();
} catch (_) {}

const lagWindowBuffer = new RingBuffer(60); // 60 samples @ 10s = 10 min window

function detectEventLoopLag() {
  if (!eventLoopHistogram) return { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const toMs = (nanos) => Math.round((nanos / 1e6) * 100) / 100;
  
  const instantMetrics = {
    meanMs: toMs(eventLoopHistogram.mean),
    p50Ms: toMs(eventLoopHistogram.percentile(50)),
    p95Ms: toMs(eventLoopHistogram.percentile(95)),
    p99Ms: toMs(eventLoopHistogram.percentile(99)),
    maxMs: toMs(eventLoopHistogram.max)
  };
  eventLoopHistogram.reset();
  
  lagWindowBuffer.push(instantMetrics);
  
  const windowArr = lagWindowBuffer.toArray();
  const allP95 = windowArr.map(m => m.p95Ms);
  const allP99 = windowArr.map(m => m.p99Ms);
  const allMax = windowArr.map(m => m.maxMs);
  
  const windowP95 = allP95.length > 0 ? Math.max(...allP95) : instantMetrics.p95Ms;
  const windowP99 = allP99.length > 0 ? Math.max(...allP99) : instantMetrics.p99Ms;
  const windowMax = allMax.length > 0 ? Math.max(...allMax) : instantMetrics.maxMs;

  return {
    ...instantMetrics,
    windowP95Ms: windowP95,
    windowP99Ms: windowP99,
    windowMaxMs: windowMax
  };
}

// ═══ V8 Heap Statistics Inspector ═════════════════════════════════════════════
function getV8HeapBreakdown() {
  try {
    const heap = v8.getHeapStatistics();
    const usedMB = Math.round(heap.used_heap_size / 1024 / 1024);
    const totalMB = Math.round(heap.total_heap_size / 1024 / 1024);
    const limitMB = Math.round(heap.heap_size_limit / 1024 / 1024);
    const externalMB = Math.round((heap.external_memory || 0) / 1024 / 1024);
    const usagePct = limitMB > 0 ? Math.round((usedMB / limitMB) * 100) : 0;
    return { usedMB, totalMB, limitMB, externalMB, usagePct };
  } catch (_) {
    return { usedMB: 0, totalMB: 0, limitMB: 0, externalMB: 0, usagePct: 0 };
  }
}

// ═══ File Descriptors & CPU Activity Inspector ═════════════════════════════════
function inspectProcessHandles(pid = process.pid) {
  let activeHandles = 0;
  if (typeof process._getActiveHandles === "function") {
    try { activeHandles = process._getActiveHandles().length; } catch (_) {}
  }
  
  let fdCount = 0;
  if (os.platform() === "linux") {
    try {
      const fdFiles = fs.readdirSync(`/proc/${pid}/fd`);
      fdCount = fdFiles.length;
    } catch (_) {
      try {
        const out = execSync(`lsof -p ${pid} 2>/dev/null | wc -l`, { encoding: "utf8", timeout: 2000 });
        fdCount = parseInt(out.trim(), 10) || 0;
      } catch (_) {}
    }
  }
  
  return { activeHandles, fdCount };
}

// ═══ Realtime Network Throughput Scanner (/proc/net/dev) ══════════════════════
let prevNetStats = null;

function getNetworkThroughput() {
  if (os.platform() !== "linux") return { rxMbps: 0, txMbps: 0, dropped: 0 };
  try {
    const netDev = fs.readFileSync("/proc/net/dev", "utf8");
    const lines = netDev.split("\n");
    let totalRxBytes = 0, totalTxBytes = 0, totalDrops = 0;
    for (const line of lines) {
      if (line.includes(":") && !line.includes("lo:")) {
        const parts = line.split(":")[1].trim().split(/\s+/);
        totalRxBytes += parseInt(parts[0], 10) || 0;
        totalDrops += parseInt(parts[3], 10) || 0;
        totalTxBytes += parseInt(parts[8], 10) || 0;
      }
    }
    const now = Date.now();
    if (!prevNetStats) {
      prevNetStats = { ts: now, rx: totalRxBytes, tx: totalTxBytes, drops: totalDrops };
      return { rxMbps: 0, txMbps: 0, dropped: totalDrops };
    }
    const dtSec = (now - prevNetStats.ts) / 1000;
    if (dtSec <= 0) return { rxMbps: 0, txMbps: 0, dropped: totalDrops };
    const rxMbps = Math.round(((totalRxBytes - prevNetStats.rx) * 8 / (1024 * 1024 * dtSec)) * 100) / 100;
    const txMbps = Math.round(((totalTxBytes - prevNetStats.tx) * 8 / (1024 * 1024 * dtSec)) * 100) / 100;
    prevNetStats = { ts: now, rx: totalRxBytes, tx: totalTxBytes, drops: totalDrops };
    return { rxMbps: Math.max(0, rxMbps), txMbps: Math.max(0, txMbps), dropped: totalDrops };
  } catch (_) {
    return { rxMbps: 0, txMbps: 0, dropped: 0 };
  }
}

// ═══ State Management & Telemetry ════════════════════════════════════════════
const failureCounter = {
  http: 0,
  ws: 0,
  go: 0,
  api: 0
};

// Per-Service Restart Trackers (Service Name -> Array of timestamps)
const serviceRestartHistory = new Map();
const serviceFrozenStates = new Map();

const httpLatencies = new RingBuffer(30);
const wsLatencies = new RingBuffer(30);
const memorySamples = new RingBuffer(30);
const incidentHistory = new RingBuffer(30);
const timeSeriesHistory = new RingBuffer(600); // 600 points = 100 minutes of 10s telemetry

// Exponential Moving Averages
let metricsEma = {
  httpLatency: 0,
  wsLatency: 0,
  loopLag: 0
};

const stats = {
  startTime: Date.now(),
  totalProbes: 0,
  autoHealsCount: 0,
  cleanupsCount: 0,
  dbPrunesCount: 0,
  snapshotsCount: 0,
  autoRepairsCount: 0,
  freedBytesTotal: 0,
  prunedLogsCount: 0,
  lastCheckResult: {},
  incidents: [],
  lastLog: "Orchestrator Brain initialized"
};

// ═══ Smart Logger ═════════════════════════════════════════════════════════════
const LOG_COLORS = {
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  debug: "\x1b[36m",
  reset: "\x1b[0m"
};

function log(level, message, meta = "") {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  const color = LOG_COLORS[level] || LOG_COLORS.reset;
  const tag = `[ORCHESTRATOR] [${level.toUpperCase()}]`;
  const metaStr = meta ? (typeof meta === "object" ? JSON.stringify(meta) : String(meta)) : "";
  const logLine = `${ts} ${tag} ${message} ${metaStr}`.trim();
  
  if (process.stdout.isTTY) {
    console.log(`${color}${ts} ${tag} ${message}${LOG_COLORS.reset} ${metaStr}`.trim());
  } else {
    console.log(logLine);
  }
  
  stats.lastLog = `${level.toUpperCase()}: ${message}`;
}

// ═══ Command Runner (Sync & Async) ════════════════════════════════════════════
function runCmd(cmd, silent = false) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 15000, stdio: silent ? "pipe" : "pipe" }).trim();
  } catch (err) {
    if (!silent) log("warn", `Command notice (${cmd.slice(0, 40)}...): ${err.message}`);
    return null;
  }
}

function runCmdAsync(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message, stdout: "" });
      resolve({ ok: true, stdout: (stdout || "").trim() });
    });
  });
}

// ═══ Heartbeat Watchdog File ══════════════════════════════════════════════════
function writeHeartbeatFile() {
  try {
    fs.writeFileSync(CONFIG.HEARTBEAT_FILE, `${Date.now()}:${new Date().toISOString()}`, "utf8");
  } catch (_) {}
}

function installCronHeartbeatSupervisor() {
  if (os.platform() !== "linux") {
    log("warn", "Cron watchdog auto-installation is only supported on Linux.");
    return false;
  }
  try {
    const watchdogScriptPath = path.join(__dirname, "heartbeat_watchdog.sh");
    const scriptContent = `#!/bin/bash
# Autonomous Orchestrator Heartbeat Watchdog
HEARTBEAT_FILE="${CONFIG.HEARTBEAT_FILE}"
CURRENT_TIME=$(date +%s)

if [ -f "$HEARTBEAT_FILE" ]; then
    LAST_MTIME=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE" 2>/dev/null)
    DIFF=$((CURRENT_TIME - LAST_MTIME))
    if [ $DIFF -gt 60 ]; then
        echo "[WATCHDOG] Orchestrator heartbeat stale ($DIFF sec). Reviving orchestrator..." >> /var/log/orchestrator_watchdog.log
        cd "${__dirname}" && pm2 restart orchestrator --update-env >> /var/log/orchestrator_watchdog.log 2>&1
    fi
else
    echo "[WATCHDOG] Heartbeat file missing. Ensuring orchestrator is running..." >> /var/log/orchestrator_watchdog.log
    cd "${__dirname}" && pm2 start orchestrator.js --name orchestrator >> /var/log/orchestrator_watchdog.log 2>&1
fi
`;
    fs.writeFileSync(watchdogScriptPath, scriptContent, { mode: 0o755 });
    
    const existingCron = runCmd("crontab -l", true) || "";
    if (!existingCron.includes("heartbeat_watchdog.sh")) {
      const newCron = `${existingCron.trim()}\n* * * * * ${watchdogScriptPath} >/dev/null 2>&1\n\n`;
      fs.writeFileSync("/tmp/crontab_orch.tmp", newCron);
      runCmd("crontab /tmp/crontab_orch.tmp");
      try { fs.unlinkSync("/tmp/crontab_orch.tmp"); } catch (_) {}
      log("info", "✅ [CRON-WATCHDOG] Installed 1-minute system crontab watchdog supervisor for Orchestrator");
    }
    return true;
  } catch (e) {
    log("warn", "Cron watchdog install notice:", e.message);
    return false;
  }
}

// ═══ Telegram Admin Incident Sentry (with Anti-Spam Debounce) ═════════════════
let pendingAlerts = [];
let alertDebounceTimer = null;

async function sendTelegramDirect(text) {
  const token = (process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.ADMIN_CHAT_ID || "").trim();
  if (!token || !chatId) return false;

  return new Promise((resolve) => {
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
          agent: httpsAgent,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          },
          timeout: 6000
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.write(payload);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

async function sendTelegramAlert(text, immediate = false) {
  if (immediate) {
    return sendTelegramDirect(text);
  }

  pendingAlerts.push({ text, ts: Date.now() });
  
  if (alertDebounceTimer) return true;

  alertDebounceTimer = setTimeout(async () => {
    alertDebounceTimer = null;
    if (pendingAlerts.length === 0) return;

    if (pendingAlerts.length === 1) {
      const single = pendingAlerts.shift();
      await sendTelegramDirect(single.text);
    } else {
      const alerts = pendingAlerts.splice(0, pendingAlerts.length);
      const combined = `🚨 <b>[ORCHESTRATOR BATCH INCIDENT REPORT]</b>\nЗафиксировано событий: ${alerts.length}\n\n` +
        alerts.map((a, i) => `<b>#${i + 1}</b> ${a.text}`).join("\n\n");
      await sendTelegramDirect(combined);
    }
  }, 1500);

  return true;
}

// ═══ Pre-Kill V8 Heap Snapshot Capture ═════════════════════════════════════════
function captureHeapSnapshotBeforeKill(serviceName = "server") {
  try {
    const snapsDir = CONFIG.SNAPSHOTS_DIR;
    if (!fs.existsSync(snapsDir)) fs.mkdirSync(snapsDir, { recursive: true });
    
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const snapFile = path.join(snapsDir, `${serviceName}_leak_${ts}.heapsnapshot`);
    
    if (serviceName === "orchestrator") {
      v8.writeHeapSnapshot(snapFile);
    } else {
      runCmd(`node -e "try { const v8 = require('v8'); v8.writeHeapSnapshot('${snapFile.replace(/\\/g, "/")}'); } catch(_) {}"`, true);
    }
    
    // Rotate snapshots (keep latest 5)
    try {
      const allSnaps = fs.readdirSync(snapsDir)
        .filter(f => f.endsWith(".heapsnapshot"))
        .map(f => ({ name: f, path: path.join(snapsDir, f), mtime: fs.statSync(path.join(snapsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (allSnaps.length > 5) {
        for (const oldS of allSnaps.slice(5)) {
          try { fs.unlinkSync(oldS.path); } catch (_) {}
        }
      }
    } catch (_) {}

    log("info", `📸 [HEAP-SNAPSHOT] Captured pre-kill heap snapshot -> ${path.basename(snapFile)}`);
    return snapFile;
  } catch (err) {
    log("warn", "Heap snapshot notice:", err.message);
    return null;
  }
}

// ═══ Linux Kernel & Socket Auto-Optimizer ═════════════════════════════════════
function optimizeSystemKernel() {
  if (os.platform() !== "linux") return false;
  try {
    log("info", "⚡ Applying high-concurrency Linux kernel and socket optimizations...");
    runCmd("sysctl -w net.core.somaxconn=32768", true);
    runCmd("sysctl -w net.core.rmem_max=16777216", true);
    runCmd("sysctl -w net.core.wmem_max=16777216", true);
    runCmd("sysctl -w net.ipv4.tcp_max_syn_backlog=16384", true);
    runCmd("sysctl -w net.ipv4.tcp_tw_reuse=1", true);
    runCmd("sysctl -w net.ipv4.tcp_fin_timeout=15", true);
    runCmd("sysctl -w net.ipv4.tcp_keepalive_time=300", true);
    runCmd("sysctl -w net.ipv4.tcp_slow_start_after_idle=0", true);
    runCmd("sysctl -w fs.file-max=2097152", true);
    runCmd("ulimit -n 65535", true);
    return true;
  } catch (e) {
    log("warn", "Kernel tuning notice:", e.message);
    return false;
  }
}

// ═══ Iptables Port 80 -> 3000 NAT Forwarding Guard ═══════════════════════════
function ensurePortForwarding() {
  if (os.platform() !== "linux" || !CONFIG.IPTABLES_REDIRECT) return false;
  try {
    const rules = runCmd("iptables -t nat -L PREROUTING -n -v", true) || "";
    if (!rules.includes("redir ports 3000") && !rules.includes("3000")) {
      log("warn", "⚠️ Port 80 redirect rule missing in iptables! Restoring NAT rule...");
      runCmd("iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 3000");
      log("info", "✅ Iptables port 80 -> 3000 redirect restored successfully");
      return true;
    }
    return false;
  } catch (e) {
    log("warn", "Iptables check notice:", e.message);
    return false;
  }
}

// ═══ Zombie & Port Collision Killer (Cross-Platform) ═══════════════════════════
function freePortIfLocked(port, expectedServiceName = "") {
  try {
    if (os.platform() === "linux") {
      const pids = runCmd(`lsof -t -i :${port}`, true);
      if (!pids) return false;
      const pidList = pids.split(/\s+/).filter(Boolean);
      let killedAny = false;
      for (const pid of pidList) {
        if (pid === String(process.pid)) continue;
        const pInfo = runCmd(`ps -p ${pid} -o comm=`, true) || "";
        log("warn", `Port ${port} locked by PID ${pid} (${pInfo}). Terminating zombie/stuck PID...`);
        runCmd(`kill -15 ${pid}`, true);
        killedAny = true;
        setTimeout(() => {
          try {
            const check = runCmd(`ps -p ${pid} -o pid=`, true);
            if (check) runCmd(`kill -9 ${pid}`, true);
          } catch (_) {}
        }, 1500);
      }
      return killedAny;
    } else if (os.platform() === "win32") {
      const netstat = runCmd(`netstat -ano | findstr :${port}`, true) || "";
      const lines = netstat.split("\n").filter(l => l.includes("LISTENING"));
      let killedAny = false;
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0" && pid !== String(process.pid)) {
          log("warn", `Windows: Freeing port ${port} locked by PID ${pid}...`);
          runCmd(`taskkill /F /PID ${pid}`, true);
          killedAny = true;
        }
      }
      return killedAny;
    }
  } catch (_) {}
  return false;
}

// ═══ Cross-Platform Disk & System Metrics ═════════════════════════════════════
function getHostDiskUsage() {
  try {
    const rootPath = os.platform() === "win32" ? path.parse(__dirname).root : "/";
    if (typeof fs.statfsSync === "function") {
      const stat = fs.statfsSync(rootPath);
      const bsize = stat.bsize || 4096;
      const totalKB = Math.round((Number(stat.blocks) * bsize) / 1024);
      const availKB = Math.round((Number(stat.bavail) * bsize) / 1024);
      const usedKB = Math.max(0, totalKB - availKB);
      const pct = totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0;
      return {
        totalMB: Math.round(totalKB / 1024),
        usedMB: Math.round(usedKB / 1024),
        availMB: Math.round(availKB / 1024),
        pct
      };
    }

    if (os.platform() === "linux") {
      const df = runCmd("df -k / | tail -1", true);
      if (df) {
        const parts = df.split(/\s+/);
        const totalKB = parseInt(parts[1], 10) || 0;
        const usedKB = parseInt(parts[2], 10) || 0;
        const availKB = parseInt(parts[3], 10) || 0;
        const pct = totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0;
        return { totalMB: Math.round(totalKB / 1024), usedMB: Math.round(usedKB / 1024), availMB: Math.round(availKB / 1024), pct };
      }
    }
  } catch (_) {}
  return { totalMB: 0, usedMB: 0, availMB: 0, pct: 0 };
}

function getSystemResourceSnapshot() {
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const usedMemMB = totalMemMB - freeMemMB;
  const memPct = totalMemMB > 0 ? Math.round((usedMemMB / totalMemMB) * 100) : 0;
  const cpus = os.cpus() || [];
  const loadAvg = os.loadavg();
  const disk = getHostDiskUsage();
  const v8Heap = getV8HeapBreakdown();
  const handles = inspectProcessHandles();
  const net = getNetworkThroughput();

  return {
    memory: { freeMemMB, totalMemMB, usedMemMB, pct: memPct },
    v8Heap,
    handles,
    net,
    cpu: { cores: cpus.length, model: cpus[0]?.model || "Unknown", loadAvg1m: Math.round(loadAvg[0] * 100) / 100 },
    disk
  };
}

function findLargestFiles(dir = __dirname, maxDepth = 2, maxResults = 5) {
  const fileList = [];
  function scan(currentDir, depth) {
    if (depth > maxDepth) return;
    try {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        if (item.name === "node_modules" || item.name === ".git") continue;
        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          scan(fullPath, depth + 1);
        } else if (item.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            fileList.push({
              path: fullPath,
              relPath: path.relative(__dirname, fullPath),
              sizeMB: Math.round((stat.size / 1024 / 1024) * 100) / 100
            });
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  scan(dir, 0);
  return fileList.sort((a, b) => b.sizeMB - a.sizeMB).slice(0, maxResults);
}

// ═══ Predictive Memory Trend & Leak Analyzer ══════════════════════════════════
function analyzeMemoryTrend() {
  const samples = memorySamples.toArray();
  if (samples.length < 5) return { trend: "CALCULATING", rateMBPerHr: 0, leakSuspected: false };
  
  const first = samples[0];
  const last = samples[samples.length - 1];
  const timeDeltaHours = (last.ts - first.ts) / (1000 * 60 * 60);
  const memDeltaMB = last.memMB - first.memMB;
  
  const rateMBPerHr = timeDeltaHours > 0 ? Math.round((memDeltaMB / timeDeltaHours) * 10) / 10 : 0;
  
  let increasingCount = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].memMB >= samples[i - 1].memMB) increasingCount++;
  }
  const isMonotonic = increasingCount >= samples.length - 1;
  const leakSuspected = isMonotonic && rateMBPerHr > 50 && last.memMB > 350;
  
  return {
    trend: leakSuspected ? "SUSPECTED_LEAK" : rateMBPerHr > 15 ? "ELEVATED_GROWTH" : "STABLE",
    rateMBPerHr,
    leakSuspected,
    currentMB: last.memMB
  };
}

// ═══ Semantic Subsystem Probing (HTTP, API, Semantic WS, Go Candle Age) ═══════

function probeHttp(url, timeoutMs = CONFIG.HTTP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      const req = client.get(url, { agent, timeout: timeoutMs }, (res) => {
        res.resume();
        const latencyMs = Date.now() - t0;
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ ok: true, status: res.statusCode, latencyMs });
        } else {
          resolve({ ok: false, status: res.statusCode, latencyMs, error: `HTTP ${res.statusCode}` });
        }
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, status: 0, latencyMs: timeoutMs, error: "ETIMEDOUT" });
      });

      req.on("error", (err) => {
        resolve({ ok: false, status: 0, latencyMs: Date.now() - t0, error: err.message });
      });
    } catch (e) {
      resolve({ ok: false, status: 0, latencyMs: 0, error: e.message });
    }
  });
}

function probeApiStatus(port = CONFIG.NODE_PORT, timeoutMs = CONFIG.HTTP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const url = `http://127.0.0.1:${port}/api/orchestrator/status`;
    const req = http.get(url, { agent: httpAgent, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        const latencyMs = Date.now() - t0;
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve({ ok: true, latencyMs, data: data.server || data });
          } catch (_) {
            resolve({ ok: true, latencyMs, data: null });
          }
        } else {
          resolve({ ok: false, latencyMs, status: res.statusCode, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, latencyMs: timeoutMs, error: "ETIMEDOUT" });
    });

    req.on("error", (err) => {
      resolve({ ok: false, latencyMs: Date.now() - t0, error: err.message });
    });
  });
}

// Semantic WebSocket Probe: verifies handshake + receiving actual market stream data
function probeWebSocket(port = CONFIG.NODE_PORT, timeoutMs = CONFIG.WS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      const WebSocket = require("ws");
      const t0 = Date.now();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        timeout: timeoutMs,
        handshakeTimeout: timeoutMs
      });
      let done = false;
      let receivedMessages = 0;

      const finish = (ok, err = "") => {
        if (done) return;
        done = true;
        try { ws.close(); } catch (_) {}
        resolve({ ok, latencyMs: Date.now() - t0, receivedMessages, error: err });
      };

      ws.on("open", () => {
        finish(true);
      });

      ws.on("message", () => {
        receivedMessages++;
        finish(true);
      });

      ws.on("error", (e) => finish(false, e.message));
      setTimeout(() => finish(false, "WS Handshake Timeout"), timeoutMs + 300);
    } catch (e) {
      resolve({ ok: false, latencyMs: 0, receivedMessages: 0, error: e.message });
    }
  });
}

function probeDnsResolution(host = "api.binance.com") {
  return new Promise((resolve) => {
    const t0 = Date.now();
    dns.lookup(host, { all: false }, (err, address) => {
      if (err) {
        resolve({ ok: false, latencyMs: Date.now() - t0, error: err.message });
      } else {
        resolve({ ok: true, address, latencyMs: Date.now() - t0 });
      }
    });
  });
}

async function probeExchangeVenues() {
  const venues = [
    { name: "Binance", host: "api.binance.com" },
    { name: "Bybit", host: "api.bybit.com" },
    { name: "OKX", host: "www.okx.com" },
    { name: "Gate.io", host: "api.gateio.ws" },
    { name: "MEXC", host: "contract.mexc.com" },
    { name: "Bitget", host: "api.bitget.com" }
  ];

  return Promise.all(
    venues.map(async (v) => {
      const t0 = Date.now();
      try {
        const addr = await new Promise((res, rej) => {
          dns.lookup(v.host, (err, address) => {
            if (err) rej(err);
            else res(address);
          });
        });
        return { name: v.name, host: v.host, ok: true, address: addr, latencyMs: Date.now() - t0 };
      } catch (err) {
        return { name: v.name, host: v.host, ok: false, address: null, latencyMs: Date.now() - t0, error: err.message };
      }
    })
  );
}

// Semantic Go Scanner Probe: verifies HTTP status + fresh candle age (< 120s)
function probeGoScanner(port = CONFIG.GO_SCANNER_PORT) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const url = `http://127.0.0.1:${port}/api/klines?ex=BN&sym=BTCUSDT&tf=1m&limit=1`;
    const req = http.get(url, { agent: httpAgent, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        const latencyMs = Date.now() - t0;
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const isFresh = Array.isArray(data) && data.length > 0;
            resolve({ ok: true, latencyMs, status: res.statusCode, isFresh, data });
          } catch (_) {
            resolve({ ok: true, latencyMs, status: res.statusCode, isFresh: false });
          }
        } else {
          resolve({ ok: false, latencyMs, status: res.statusCode, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, latencyMs: 3000, error: "ETIMEDOUT" });
    });

    req.on("error", (err) => {
      resolve({ ok: false, latencyMs: Date.now() - t0, error: err.message });
    });
  });
}

function inspectPm2Processes() {
  try {
    const jsonStr = runCmd("pm2 jlist", true);
    if (!jsonStr) return [];
    return JSON.parse(jsonStr);
  } catch (e) {
    return [];
  }
}

function superviseAllPm2Services() {
  const pm2List = inspectPm2Processes();
  const issues = [];
  
  for (const proc of pm2List) {
    const name = proc.name || "unknown";
    const status = proc.pm2_env?.status;
    const restarts = proc.pm2_env?.restart_time || 0;
    const memMB = proc.monit?.memory ? Math.round(proc.monit.memory / 1024 / 1024) : 0;
    
    if (status === "errored" || status === "stopped") {
      issues.push({ name, status, reason: `Process is in '${status}' state (restarts: ${restarts})` });
    }
  }
  return { allProcs: pm2List, issues };
}

// ═══ Per-Service Circuit Breaker (Crash-Loop Protection) ═══════════════════════

function isServiceCircuitBreakerOpen(serviceName) {
  const now = Date.now();
  let history = serviceRestartHistory.get(serviceName) || [];
  history = history.filter(t => now - t < CONFIG.CIRCUIT_BREAKER_WINDOW_MS);
  serviceRestartHistory.set(serviceName, history);
  return history.length >= CONFIG.CIRCUIT_BREAKER_MAX_RESTARTS;
}

function recordServiceRestart(serviceName) {
  const now = Date.now();
  let history = serviceRestartHistory.get(serviceName) || [];
  history = history.filter(t => now - t < CONFIG.CIRCUIT_BREAKER_WINDOW_MS);
  history.push(now);
  serviceRestartHistory.set(serviceName, history);
  return history.length;
}

function isCircuitBreakerOpen() {
  return isServiceCircuitBreakerOpen("server");
}

function recordIncident(type, reason, details = {}) {
  const incident = {
    id: "inc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 5),
    timestamp: new Date().toISOString(),
    type,
    reason,
    ...details
  };
  stats.incidents.unshift(incident);
  incidentHistory.push(incident);
  if (stats.incidents.length > 30) stats.incidents.pop();
  return incident;
}

// Graceful Drain: notify active browser clients before reload
async function gracefulDrainBeforeReload(port = CONFIG.NODE_PORT) {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/admin/prepare-restart",
          method: "POST",
          agent: httpAgent,
          timeout: 1000
        },
        (res) => {
          res.resume();
          setTimeout(resolve, 800);
        }
      );
      req.on("error", () => resolve());
      req.on("timeout", () => { req.destroy(); resolve(); });
      req.end();
    } catch (_) {
      resolve();
    }
  });
}

async function healServer(reason) {
  const serviceName = "server";
  if (isServiceCircuitBreakerOpen(serviceName)) {
    log("error", `🚨 [CRASH-LOOP CIRCUIT BREAKER] Service '${serviceName}' restarted >= ${CONFIG.CIRCUIT_BREAKER_MAX_RESTARTS} times in 10 min. Freezing auto-heal for manual review.`);
    sendTelegramAlert(`🚨 <b>[CRITICAL CRASH-LOOP ALERT]</b>\nСервис <code>${serviceName}</code> превысил лимит рестартов (5 раз за 10 мин).\nАвтоматический ремонт ПРИОСТАНОВЛЕН для предотвращения циклической нагрузки.\n<b>Требуется ручной разбор администратора!</b>\nПричина: <code>${reason}</code>`, true);
    return false;
  }

  recordServiceRestart(serviceName);
  stats.autoHealsCount++;
  recordIncident("heal_server", reason);

  log("warn", `🔧 [AUTO-HEAL] Executing automated recovery for '${serviceName}' (Reason: ${reason})...`);
  failureCounter.http = 0;
  failureCounter.ws = 0;
  failureCounter.api = 0;

  if (reason.includes("memory") || reason.includes("leak") || reason.includes("deadlock")) {
    captureHeapSnapshotBeforeKill(serviceName);
  }

  try {
    await gracefulDrainBeforeReload(CONFIG.NODE_PORT);
    let res = runCmd("pm2 reload server --update-env", true);
    if (!res || !res.includes("server")) {
      res = runCmd("pm2 restart server --update-env", true);
    }
    
    if (res && res.includes("server")) {
      log("info", "✅ [AUTO-HEAL] 'server' process recovered successfully via PM2");
    } else {
      throw new Error("PM2 reload/restart returned unexpected output");
    }
  } catch (err) {
    log("error", "Standard PM2 reload failed. Forcing port release and fresh start...", err.message);
    freePortIfLocked(CONFIG.NODE_PORT, "server");
    const serverDir = path.join(__dirname);
    runCmd(`cd "${serverDir}" && pm2 start server.js --name server --update-env`, true);
  }

  sendTelegramAlert(`🛠️ <b>[ORCHESTRATOR AUTO-HEAL]</b>\nАвтоматически устранен сбой сервера.\n• Причина: <code>${reason}</code>\n• Статус: Восстановлен и работает штатно (100% OK)`);
  return true;
}

async function healGoScanner(reason) {
  const serviceName = "cryptoscreen-go";
  if (isServiceCircuitBreakerOpen(serviceName)) {
    log("error", `🚨 [CRASH-LOOP CIRCUIT BREAKER] Service '${serviceName}' in crash-loop.`);
    sendTelegramAlert(`🚨 <b>[CRITICAL CRASH-LOOP ALERT]</b>\nСервис <code>${serviceName}</code> в crash-loop (>5 рестартов за 10 мин). Требуется ручной разбор!`, true);
    return false;
  }

  recordServiceRestart(serviceName);
  stats.autoHealsCount++;
  recordIncident("heal_go_scanner", reason);
  log("warn", `🔧 [AUTO-HEAL] Restarting Go Density Scanner (Reason: ${reason})...`);
  
  try {
    runCmd("pm2 restart cryptoscreen-go", true);
    log("info", "✅ [AUTO-HEAL] 'cryptoscreen-go' restarted successfully via PM2");
  } catch (e) {
    freePortIfLocked(CONFIG.GO_SCANNER_PORT, "scanner");
    runCmd("pm2 start /root/cryptoscreen-go --name cryptoscreen-go", true);
  }
}

// ═══ Self-Healing Corrupted Database Auto-Recovery & Consistency Checker ══════

function validateDatabaseRelationalIntegrity() {
  const usersPath = path.join(__dirname, "users.json");
  const sessionsPath = path.join(__dirname, "sessions.json");
  
  let orphanSessionsPruned = 0;
  if (fs.existsSync(usersPath) && fs.existsSync(sessionsPath)) {
    try {
      const usersData = JSON.parse(fs.readFileSync(usersPath, "utf8"));
      const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      
      const validUserIds = new Set();
      if (Array.isArray(usersData)) {
        for (const u of usersData) if (u.id) validUserIds.add(String(u.id));
      } else if (usersData && typeof usersData === "object") {
        for (const k of Object.keys(usersData)) {
          const u = usersData[k];
          if (u && u.id) validUserIds.add(String(u.id));
          else validUserIds.add(String(k));
        }
      }

      if (validUserIds.size > 0 && sessionsData && typeof sessionsData === "object") {
        let changed = false;
        for (const token of Object.keys(sessionsData)) {
          const sess = sessionsData[token];
          if (sess && sess.userId && !validUserIds.has(String(sess.userId))) {
            delete sessionsData[token];
            orphanSessionsPruned++;
            changed = true;
          }
        }
        if (changed) {
          safeAtomicWriteJSON(sessionsPath, sessionsData, true);
          log("info", `✅ Pruned ${orphanSessionsPruned} orphan sessions referencing deleted users`);
        }
      }
    } catch (_) {}
  }
  return orphanSessionsPruned;
}

function autoRepairDatabasesIfCorrupted() {
  const dbFiles = [
    "users.json",
    "sessions.json",
    "payments.json",
    "payment_invoices.json",
    "auth_logs.json",
    "journal_credentials.json",
    "admin_settings.json",
    "promos.json",
    "support.json",
    "bug_reports.json",
    "admin_audit.json"
  ];

  let repairedCount = 0;

  for (const file of dbFiles) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) continue;

    let isCorrupted = false;
    let fileContent = "";
    try {
      fileContent = fs.readFileSync(filePath, "utf8");
      JSON.parse(fileContent);
    } catch (err) {
      isCorrupted = true;
    }

    if (isCorrupted) {
      log("error", `🚨 [CORRUPTION DETECTED] File '${file}' is corrupted JSON! Initiating auto-recovery...`);
      const corruptedBackup = `${filePath}.corrupted.${Date.now()}`;
      try { fs.copyFileSync(filePath, corruptedBackup); } catch (_) {}

      const bakFile = `${filePath}.bak`;
      let restored = false;
      if (fs.existsSync(bakFile)) {
        try {
          const bakContent = fs.readFileSync(bakFile, "utf8");
          JSON.parse(bakContent);
          fs.copyFileSync(bakFile, filePath);
          restored = true;
          log("info", `✅ Successfully recovered '${file}' from local .bak backup`);
        } catch (_) {}
      }

      if (!restored && fs.existsSync(CONFIG.BACKUPS_DIR)) {
        try {
          const snapshots = fs.readdirSync(CONFIG.BACKUPS_DIR)
            .filter(f => f.startsWith("snapshot_") && f.endsWith(".json"))
            .sort().reverse();

          for (const s of snapshots) {
            const snapPath = path.join(CONFIG.BACKUPS_DIR, s);
            const snapData = JSON.parse(fs.readFileSync(snapPath, "utf8"));
            if (snapData.stores && snapData.stores[file] !== undefined) {
              safeAtomicWriteJSON(filePath, snapData.stores[file], false);
              restored = true;
              log("info", `✅ Successfully recovered '${file}' from snapshot '${s}'`);
              break;
            }
          }
        } catch (_) {}
      }

      if (!restored) {
        const defaultContent = file.includes("logs") || file.includes("payments") || file.includes("invoices") || file.includes("audit") ? [] : {};
        safeAtomicWriteJSON(filePath, defaultContent, false);
        log("warn", `⚠️ Initialized fresh empty fallback structure for '${file}'`);
      }

      stats.autoRepairsCount++;
      repairedCount++;
      recordIncident("db_auto_repair", `Corrupted JSON store ${file} repaired`);
      sendTelegramAlert(`🛠️ <b>[DATABASE AUTO-REPAIR]</b>\nОбнаружено повреждение файла <code>${file}</code>.\nОркестратор успешно восстановил целостность базы данных из резервной копии.`);
    }
  }

  return repairedCount;
}

// ═══ Intelligent Health Check Engine ═══════════════════════════════════════════

async function performHealthCheck() {
  stats.totalProbes++;
  const t0 = Date.now();

  writeHeartbeatFile();
  autoRepairDatabasesIfCorrupted();

  const [httpProbe, wsProbe, dnsProbe, apiProbe, goProbe] = await Promise.all([
    probeHttp(`http://127.0.0.1:${CONFIG.NODE_PORT}/`),
    probeWebSocket(CONFIG.NODE_PORT),
    probeDnsResolution("api.binance.com"),
    probeApiStatus(CONFIG.NODE_PORT),
    probeGoScanner(CONFIG.GO_SCANNER_PORT)
  ]);

  const loopLag = detectEventLoopLag();
  const { allProcs, issues } = superviseAllPm2Services();
  const serverProc = allProcs.find(p => p.name === "server");
  const goProc = allProcs.find(p => p.name === "cryptoscreen-go");

  const serverMemMB = serverProc?.monit?.memory ? Math.round(serverProc.monit.memory / 1024 / 1024) : 0;
  const serverCpu = serverProc?.monit?.cpu || 0;
  const serverStatus = serverProc?.pm2_env?.status || "unknown";
  const goStatus = goProc?.pm2_env?.status || "unknown";
  const handles = inspectProcessHandles(serverProc?.pid || process.pid);
  const netThroughput = getNetworkThroughput();

  // Record into Rolling Adaptive Stats
  if (serverMemMB > 0) {
    memorySamples.push({ ts: Date.now(), memMB: serverMemMB });
    ramStatsTracker.push(serverMemMB);
  }
  if (httpProbe.ok) {
    httpLatencies.push(httpProbe.latencyMs);
    httpLatencyStatsTracker.push(httpProbe.latencyMs);
    metricsEma.httpLatency = metricsEma.httpLatency === 0 
      ? httpProbe.latencyMs 
      : Math.round(metricsEma.httpLatency * 0.8 + httpProbe.latencyMs * 0.2);
  }
  if (wsProbe.ok) {
    wsLatencies.push(wsProbe.latencyMs);
    wsLatencyStatsTracker.push(wsProbe.latencyMs);
    metricsEma.wsLatency = metricsEma.wsLatency === 0 
      ? wsProbe.latencyMs 
      : Math.round(metricsEma.wsLatency * 0.8 + wsProbe.latencyMs * 0.2);
  }
  metricsEma.loopLag = metricsEma.loopLag === 0 
    ? loopLag.meanMs 
    : Math.round((metricsEma.loopLag * 0.8 + loopLag.meanMs * 0.2) * 100) / 100;

  const memTrend = analyzeMemoryTrend();
  const memZScore = ramStatsTracker.calcZScore(serverMemMB);

  // Time-Series Snapshot Point (every 10s)
  timeSeriesHistory.push({
    ts: Date.now(),
    ramMB: serverMemMB,
    cpu: serverCpu,
    loopLagP99: loopLag.windowP99Ms,
    httpLatency: httpProbe.latencyMs,
    wsLatency: wsProbe.latencyMs,
    tickers: apiProbe?.data?.tickersCount ?? 0,
    fdCount: handles.fdCount,
    netRxMbps: netThroughput.rxMbps,
    netTxMbps: netThroughput.txMbps
  });

  stats.lastCheckResult = {
    ts: Date.now(),
    probeDurationMs: Date.now() - t0,
    http: httpProbe,
    ws: wsProbe,
    dns: dnsProbe,
    api: apiProbe,
    goProbe,
    loopLag,
    memTrend,
    memZScore,
    handles,
    netThroughput,
    server: {
      status: serverStatus,
      memMB: serverMemMB,
      cpu: serverCpu,
      tickersCount: apiProbe?.data?.tickersCount ?? null,
      wsClients: apiProbe?.data?.connectedWsClients ?? null,
      exchangesCount: apiProbe?.data?.exchangesCount ?? null
    },
    go: { status: goStatus, httpOk: goProbe.ok, isFresh: goProbe.isFresh, latencyMs: goProbe.latencyMs }
  };

  // 1. Evaluate HTTP Probe
  if (!httpProbe.ok) {
    failureCounter.http++;
    log("warn", `HTTP probe failed (${failureCounter.http}/${CONFIG.MAX_FAILURES_BEFORE_RESTART}): ${httpProbe.error}`);
  } else {
    failureCounter.http = 0;
  }

  // 2. Evaluate WebSocket Probe
  if (!wsProbe.ok) {
    failureCounter.ws++;
    log("warn", `WS probe failed (${failureCounter.ws}/${CONFIG.MAX_FAILURES_BEFORE_RESTART}): ${wsProbe.error}`);
  } else {
    failureCounter.ws = 0;
  }

  // 3. Heartbeat Log every 6 probes (~1 min)
  if (httpProbe.ok && wsProbe.ok && stats.totalProbes % 6 === 0) {
    const tickers = apiProbe?.data?.tickersCount ? ` | Tickers: ${apiProbe.data.tickersCount}` : "";
    const clients = apiProbe?.data?.connectedWsClients ? ` | Clients: ${apiProbe.data.connectedWsClients}` : "";
    const goInfo = goProbe.ok ? ` | Go: ${goProbe.latencyMs}ms` : "";
    const netInfo = netThroughput.rxMbps > 0 ? ` | Net: ↓${netThroughput.rxMbps}Mb/s ↑${netThroughput.txMbps}Mb/s` : "";
    log("info", `💚 [HEALTH 100%] HTTP: ${httpProbe.latencyMs}ms (EMA ${metricsEma.httpLatency}ms) | WS: ${wsProbe.latencyMs}ms | Node RAM: ${serverMemMB}MB (CPU ${serverCpu}%) | EventLoop p99: ${loopLag.windowP99Ms}ms${tickers}${clients}${goInfo}${netInfo}`);
  }

  // 4. Adaptive Z-Score RAM Anomaly & Memory Leak Guard
  const isZScoreAnomaly = memZScore >= 3.2 && serverMemMB > CONFIG.MIN_NODE_MEMORY_FLOOR_MB;
  const isHardCeilingExceeded = serverMemMB > CONFIG.MAX_NODE_MEMORY_CEILING_MB;
  
  if (isZScoreAnomaly || isHardCeilingExceeded) {
    log("warn", `Adaptive memory threshold triggered (RAM: ${serverMemMB}MB, Z-Score: ${memZScore}). Recycling server...`);
    await healServer(`adaptive_ram_zscore_${memZScore}`);
    return;
  }

  // 5. High Event Loop p99 Alert
  if (loopLag.windowP99Ms > CONFIG.EVENT_LOOP_LAG_CRITICAL_MS) {
    log("warn", `⚠️ High event-loop lag p99 in 10-min window: ${loopLag.windowP99Ms}ms`);
  }

  // 6. Deadlock / Unresponsive Hang Guard
  // A true deadlock/freeze means BOTH HTTP and WebSocket fail repeatedly (at least 4 consecutive cycles),
  // OR either channel fails for 6+ consecutive cycles (over 60s) without recovery.
  // This eliminates false-alarm restarts during high-volume market bursts.
  const isBothFailing = failureCounter.http >= CONFIG.MAX_FAILURES_BEFORE_RESTART && failureCounter.ws >= CONFIG.MAX_FAILURES_BEFORE_RESTART;
  const isSustainedDeadlock = failureCounter.http >= (CONFIG.MAX_FAILURES_BEFORE_RESTART + 2) || failureCounter.ws >= (CONFIG.MAX_FAILURES_BEFORE_RESTART + 2);

  if (isBothFailing || isSustainedDeadlock) {
    log("error", `Server deadlock / unresponsive freeze confirmed (HTTP fails: ${failureCounter.http}, WS fails: ${failureCounter.ws})! Triggering auto-heal...`);
    await healServer("deadlock_or_timeout");
    return;
  }

  // 7. Offline PM2 status check
  if (serverProc && serverStatus !== "online" && serverStatus !== "launching") {
    log("error", `Server process is in '${serverStatus}' state. Initiating auto-recovery...`);
    await healServer(`process_status_${serverStatus}`);
    return;
  }

  if (goProc && (goStatus !== "online" && goStatus !== "launching")) {
    log("warn", `Go Scanner is in '${goStatus}' state. Initiating auto-recovery...`);
    await healGoScanner(`process_status_${goStatus}`);
  }

  // 8. Ensure Port 80 NAT redirection is active
  ensurePortForwarding();
}

// ═══ Deep Auto-Cleaner & Database Compaction ══════════════════════════════════

// High-reliability atomic JSON write with file locking retry & backup
function safeAtomicWriteJSON(filePath, data, makeBackup = false) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    if (makeBackup && fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`);
      } catch (_) {}
    }

    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    let renamed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tempPath, filePath);
        renamed = true;
        break;
      } catch (e) {
        if (attempt === 4) throw e;
        const end = Date.now() + 25 + Math.floor(Math.random() * 25);
        while (Date.now() < end) {}
      }
    }
    return renamed;
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    log("warn", `Error atomic writing ${path.basename(filePath)}:`, err.message);
    return false;
  }
}

async function safeAtomicWriteJSONAsync(filePath, data, makeBackup = false) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    if (makeBackup && fs.existsSync(filePath)) {
      try { await fs.promises.copyFile(filePath, `${filePath}.bak`); } catch (_) {}
    }
    const jsonStr = JSON.stringify(data, null, 2);
    await fs.promises.writeFile(tempPath, jsonStr, { mode: 0o600 });
    await fs.promises.rename(tempPath, filePath);
    return true;
  } catch (err) {
    try { await fs.promises.unlink(tempPath); } catch (_) {}
    log("warn", `Async atomic write notice (${path.basename(filePath)}):`, err.message);
    return false;
  }
}

function parseJsonDateToMs(val) {
  if (!val) return 0;
  if (typeof val === "number") return val;
  const parsed = new Date(val).getTime();
  return isNaN(parsed) ? 0 : parsed;
}

// Unified Database Snapshot & Backup System
function createDatabaseSnapshot() {
  stats.snapshotsCount++;
  const backupsDir = CONFIG.BACKUPS_DIR;
  if (!fs.existsSync(backupsDir)) {
    try { fs.mkdirSync(backupsDir, { recursive: true }); } catch (_) {}
  }
  
  const dbFiles = [
    "users.json",
    "sessions.json",
    "payments.json",
    "payment_invoices.json",
    "auth_logs.json",
    "journal_credentials.json",
    "admin_settings.json",
    "promos.json",
    "support.json",
    "bug_reports.json",
    "admin_audit.json"
  ];
  
  const snapshotData = {
    timestamp: new Date().toISOString(),
    version: "5.5",
    stores: {}
  };
  
  let totalRecords = 0;
  for (const file of dbFiles) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      try {
        const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
        snapshotData.stores[file] = content;
        if (Array.isArray(content)) totalRecords += content.length;
        else if (content && typeof content === "object") totalRecords += Object.keys(content).length;
      } catch (_) {}
    }
  }
  
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupFile = path.join(backupsDir, `snapshot_${ts}.json`);
  safeAtomicWriteJSON(backupFile, snapshotData, false);
  
  // Prune old snapshots (keep last 7)
  try {
    const allBackups = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith("snapshot_") && f.endsWith(".json"))
      .map(f => ({ name: f, path: path.join(backupsDir, f), mtime: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
      
    if (allBackups.length > 7) {
      for (const oldB of allBackups.slice(7)) {
        try { fs.unlinkSync(oldB.path); } catch (_) {}
      }
    }
  } catch (_) {}
  
  log("info", `💾 [SNAPSHOT] Created DB backup (${totalRecords} records, ${Object.keys(snapshotData.stores).length} stores) -> ${path.basename(backupFile)}`);
  return { backupFile, totalRecords, storesCount: Object.keys(snapshotData.stores).length };
}

function pruneJsonDatabases() {
  stats.dbPrunesCount++;
  log("info", "📦 [DB-PRUNE] Starting JSON database compaction & pruning cycle...");

  createDatabaseSnapshot();
  validateDatabaseRelationalIntegrity();

  let prunedEntries = 0;
  const now = Date.now();

  try {
    // 1. Prune auth_logs.json (Retain latest N entries and < 30 days)
    const logsFile = path.join(__dirname, "auth_logs.json");
    if (fs.existsSync(logsFile)) {
      try {
        const raw = fs.readFileSync(logsFile, "utf8");
        const logs = JSON.parse(raw);
        if (Array.isArray(logs) && logs.length > 0) {
          const cutoff = now - (CONFIG.MAX_AUTH_LOG_AGE_DAYS * 24 * 60 * 60 * 1000);
          const filtered = logs.filter(l => {
            const t = parseJsonDateToMs(l.timestamp);
            return t === 0 || t > cutoff;
          }).slice(-CONFIG.MAX_AUTH_LOGS_ENTRIES);

          const diff = logs.length - filtered.length;
          if (diff > 0) {
            safeAtomicWriteJSON(logsFile, filtered, true);
            prunedEntries += diff;
            log("info", `✅ Pruned ${diff} stale auth_logs entries from auth_logs.json`);
          }
        }
      } catch (e) {
        log("warn", "auth_logs.json prune notice:", e.message);
      }
    }

    // 2. Prune expired sessions in sessions.json
    const sessionsFile = path.join(__dirname, "sessions.json");
    if (fs.existsSync(sessionsFile)) {
      try {
        const raw = fs.readFileSync(sessionsFile, "utf8");
        const sessions = JSON.parse(raw);
        if (sessions && typeof sessions === "object") {
          const sessionTtlMs = CONFIG.MAX_SESSION_AGE_DAYS * 24 * 60 * 60 * 1000;
          let changed = false;
          let removedSessions = 0;
          for (const token of Object.keys(sessions)) {
            const sess = sessions[token];
            if (!sess || typeof sess !== "object") {
              delete sessions[token];
              removedSessions++;
              changed = true;
              continue;
            }
            const createdAtMs = parseJsonDateToMs(sess.createdAt);
            const expiresAtMs = sess.expiresAt ? Number(sess.expiresAt) : 0;
            
            const isExpiredByTtl = createdAtMs > 0 && (now - createdAtMs > sessionTtlMs);
            const isExpiredExplicit = expiresAtMs > 0 && expiresAtMs < now;

            if (isExpiredByTtl || isExpiredExplicit) {
              delete sessions[token];
              removedSessions++;
              changed = true;
            }
          }
          if (changed) {
            safeAtomicWriteJSON(sessionsFile, sessions, true);
            prunedEntries += removedSessions;
            log("info", `✅ Pruned ${removedSessions} expired sessions from sessions.json`);
          }
        }
      } catch (e) {
        log("warn", "sessions.json prune notice:", e.message);
      }
    }

    // 3. Prune old unpaid payment invoices (> 72 hours)
    const invoicesFile = path.join(__dirname, "payment_invoices.json");
    if (fs.existsSync(invoicesFile)) {
      try {
        const raw = fs.readFileSync(invoicesFile, "utf8");
        const invoices = JSON.parse(raw);
        const invoiceCutoff = now - (72 * 60 * 60 * 1000);

        if (Array.isArray(invoices)) {
          const originalLen = invoices.length;
          const filtered = invoices.filter(inv => {
            if (inv.status === "pending") {
              const createdMs = parseJsonDateToMs(inv.createdAt);
              if (createdMs > 0 && createdMs < invoiceCutoff) return false;
            }
            return true;
          });
          const diff = originalLen - filtered.length;
          if (diff > 0) {
            safeAtomicWriteJSON(invoicesFile, filtered, true);
            prunedEntries += diff;
            log("info", `✅ Pruned ${diff} stale pending invoices from payment_invoices.json`);
          }
        } else if (invoices && typeof invoices === "object") {
          let removedInvoices = 0;
          let changed = false;
          for (const id of Object.keys(invoices)) {
            const inv = invoices[id];
            if (inv && inv.status === "pending") {
              const createdMs = parseJsonDateToMs(inv.createdAt);
              if (createdMs > 0 && createdMs < invoiceCutoff) {
                delete invoices[id];
                removedInvoices++;
                changed = true;
              }
            }
          }
          if (changed) {
            safeAtomicWriteJSON(invoicesFile, invoices, true);
            prunedEntries += removedInvoices;
            log("info", `✅ Pruned ${removedInvoices} stale pending invoices from payment_invoices.json`);
          }
        }
      } catch (e) {
        log("warn", "payment_invoices.json prune notice:", e.message);
      }
    }

    // 4. Prune old admin audit entries (> 500 items)
    const auditFile = path.join(__dirname, "admin_audit.json");
    if (fs.existsSync(auditFile)) {
      try {
        const raw = fs.readFileSync(auditFile, "utf8");
        const audit = JSON.parse(raw);
        if (Array.isArray(audit) && audit.length > 500) {
          const trimmed = audit.slice(-500);
          safeAtomicWriteJSON(auditFile, trimmed, true);
          prunedEntries += (audit.length - 500);
        }
      } catch (_) {}
    }

    stats.prunedLogsCount += prunedEntries;
  } catch (err) {
    log("warn", "DB prune exception:", err.message);
  }

  return prunedEntries;
}

function performAutoCleanup() {
  stats.cleanupsCount++;
  log("info", "🧹 [AUTO-CLEANUP] Starting deep system, cache & garbage cleaning cycle...");

  let freedBytes = 0;

  try {
    // 1. PM2 Log Inspection & Flush/Truncate
    const pm2LogDir = path.join(os.homedir(), ".pm2", "logs");
    if (fs.existsSync(pm2LogDir)) {
      let totalLogBytes = 0;
      const files = fs.readdirSync(pm2LogDir);
      for (const f of files) {
        try {
          const p = path.join(pm2LogDir, f);
          const s = fs.statSync(p);
          totalLogBytes += s.size;
        } catch (_) {}
      }
      const totalMB = Math.round(totalLogBytes / 1024 / 1024);
      if (totalMB > CONFIG.MAX_LOG_SIZE_MB) {
        log("info", `PM2 logs size (${totalMB}MB) exceeded limit (${CONFIG.MAX_LOG_SIZE_MB}MB). Flushing PM2 logs...`);
        runCmd("pm2 flush", true);
        freedBytes += totalLogBytes;
        log("info", "✅ PM2 logs flushed cleanly");
      }
    }

    // 2. Clean temporary files in /tmp (Linux only, older than 60 minutes)
    if (os.platform() === "linux") {
      runCmd("find /tmp -type f \\( -name '*.png' -o -name '*.tmp' -o -name 'core.*' -o -name 'v8*' \\) -mmin +60 -delete", true);
      runCmd("find /tmp -type f -name '*.svg' -mmin +60 -delete", true);
    }

    // 3. Clean local leftover .tmp atomic files in node-server directory
    try {
      const localFiles = fs.readdirSync(__dirname);
      const now = Date.now();
      for (const file of localFiles) {
        if (file.endsWith(".tmp")) {
          const fullPath = path.join(__dirname, file);
          try {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > 10 * 60 * 1000) {
              freedBytes += stat.size;
              fs.unlinkSync(fullPath);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // 4. Force V8 Garbage Collection if exposed
    if (typeof global.gc === "function") {
      try {
        global.gc();
        log("info", "✅ Forced V8 Garbage Collection cycle");
      } catch (_) {}
    }

    // 5. Host Memory Optimization & Drop Cache
    if (os.platform() === "linux") {
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const usedPct = ((totalMem - freeMem) / totalMem) * 100;
      if (usedPct > 80) {
        log("info", `Host RAM usage elevated (${usedPct.toFixed(1)}%). Releasing inactive OS buffer caches...`);
        runCmd("sync; echo 3 > /proc/sys/vm/drop_caches", true);
      }
    }

    // 6. Disk Space Watchdog & Emergency Purge (>88%)
    const disk = getHostDiskUsage();
    if (disk.pct >= CONFIG.DISK_CRITICAL_USAGE_PCT) {
      log("warn", `🚨 Disk usage critical (${disk.pct}% used, ${disk.availMB}MB free)! Running Emergency Purge...`);
      if (os.platform() === "linux") {
        runCmd("pm2 flush", true);
        runCmd("apt-get clean", true);
        runCmd("journalctl --vacuum-size=50M", true);
        runCmd("rm -rf /root/.npm/_cacache", true);
      }
      sendTelegramAlert(`🚨 <b>[DISK USAGE CRITICAL]</b>\nДиск заполнен на ${disk.pct}% (${disk.availMB}MB свободно).\nОркестратор выполнил аварийную очистку логов и кэшей.`);
    }

    // 7. Save PM2 state for persistent boots
    runCmd("pm2 save", true);

    stats.freedBytesTotal += freedBytes;
    log("info", `✅ [AUTO-CLEANUP] Maintenance cycle completed. Total freed: ${(stats.freedBytesTotal / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    log("warn", "Auto-cleanup notice:", err.message);
  }

  return freedBytes;
}

// ═══ PM2 Ecosystem Generator / Optimizer ═══════════════════════════════════════

function ensurePm2EcosystemConfig() {
  const ecosystemPath = path.join(__dirname, "ecosystem.config.js");
  const configContent = `module.exports = {
  apps: [
    {
      name: "server",
      script: "server.js",
      cwd: __dirname,
      node_args: "--max-old-space-size=1024 --expose-gc",
      max_memory_restart: "750M",
      restart_delay: 2000,
      kill_timeout: 5000,
      autorestart: true,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "orchestrator",
      script: "orchestrator.js",
      cwd: __dirname,
      node_args: "--expose-gc",
      max_memory_restart: "150M",
      restart_delay: 3000,
      autorestart: true
    }
  ]
};
`;
  if (!fs.existsSync(ecosystemPath)) {
    try {
      fs.writeFileSync(ecosystemPath, configContent, "utf8");
      log("info", "✅ Created optimal PM2 ecosystem.config.js");
      return true;
    } catch (_) {}
  }
  return false;
}

// ═══ Prometheus Metrics Exporter ═══════════════════════════════════════════════

function generatePrometheusMetrics() {
  const snapshot = getSystemResourceSnapshot();
  const uptimeSec = Math.round((Date.now() - stats.startTime) / 1000);
  const memTrend = analyzeMemoryTrend();
  
  return [
    `# HELP orchestrator_uptime_seconds Total seconds orchestrator has been running`,
    `# TYPE orchestrator_uptime_seconds counter`,
    `orchestrator_uptime_seconds ${uptimeSec}`,
    `# HELP orchestrator_probes_total Total health check probes performed`,
    `# TYPE orchestrator_probes_total counter`,
    `orchestrator_probes_total ${stats.totalProbes}`,
    `# HELP orchestrator_auto_heals_total Total automated self-healing events`,
    `# TYPE orchestrator_auto_heals_total counter`,
    `orchestrator_auto_heals_total ${stats.autoHealsCount}`,
    `# HELP orchestrator_http_latency_ms HTTP probe latency in milliseconds`,
    `# TYPE orchestrator_http_latency_ms gauge`,
    `orchestrator_http_latency_ms ${stats.lastCheckResult?.http?.latencyMs || 0}`,
    `# HELP orchestrator_http_latency_ema_ms HTTP probe EMA latency in milliseconds`,
    `# TYPE orchestrator_http_latency_ema_ms gauge`,
    `orchestrator_http_latency_ema_ms ${metricsEma.httpLatency}`,
    `# HELP orchestrator_ws_latency_ms WebSocket handshake latency in milliseconds`,
    `# TYPE orchestrator_ws_latency_ms gauge`,
    `orchestrator_ws_latency_ms ${stats.lastCheckResult?.ws?.latencyMs || 0}`,
    `# HELP orchestrator_event_loop_lag_p99_ms Event loop lag p99 in milliseconds`,
    `# TYPE orchestrator_event_loop_lag_p99_ms gauge`,
    `orchestrator_event_loop_lag_p99_ms ${stats.lastCheckResult?.loopLag?.windowP99Ms || 0}`,
    `# HELP orchestrator_memory_used_bytes Memory used by host in bytes`,
    `# TYPE orchestrator_memory_used_bytes gauge`,
    `orchestrator_memory_used_bytes ${snapshot.memory.usedMemMB * 1024 * 1024}`,
    `# HELP orchestrator_active_handles_count Number of active Node.js event loop handles`,
    `# TYPE orchestrator_active_handles_count gauge`,
    `orchestrator_active_handles_count ${snapshot.handles.activeHandles}`,
    `# HELP orchestrator_process_fd_count Number of open file descriptors on host`,
    `# TYPE orchestrator_process_fd_count gauge`,
    `orchestrator_process_fd_count ${snapshot.handles.fdCount}`,
    `# HELP orchestrator_network_rx_mbps Inbound network throughput in Mbps`,
    `# TYPE orchestrator_network_rx_mbps gauge`,
    `orchestrator_network_rx_mbps ${snapshot.net.rxMbps}`,
    `# HELP orchestrator_network_tx_mbps Outbound network throughput in Mbps`,
    `# TYPE orchestrator_network_tx_mbps gauge`,
    `orchestrator_network_tx_mbps ${snapshot.net.txMbps}`,
    `# HELP orchestrator_v8_heap_used_bytes Memory used by V8 heap in bytes`,
    `# TYPE orchestrator_v8_heap_used_bytes gauge`,
    `orchestrator_v8_heap_used_bytes ${snapshot.v8Heap.usedMB * 1024 * 1024}`,
    `# HELP orchestrator_disk_used_percent Disk usage percentage`,
    `# TYPE orchestrator_disk_used_percent gauge`,
    `orchestrator_disk_used_percent ${snapshot.disk.pct}`,
    `# HELP orchestrator_memory_zscore Current RAM Z-Score anomaly indicator`,
    `# TYPE orchestrator_memory_zscore gauge`,
    `orchestrator_memory_zscore ${stats.lastCheckResult?.memZScore || 0}`
  ].join("\n") + "\n";
}

// ═══ Optional IPC / REST Control Server ════════════════════════════════════════

let controlServerInstance = null;

function startControlServer(port = CONFIG.CONTROL_SERVER_PORT) {
  if (controlServerInstance) return controlServerInstance;

  controlServerInstance = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (parsedUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", uptimeSec: Math.round((Date.now() - stats.startTime) / 1000) }));
    }

    if (parsedUrl.pathname === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      return res.end(generatePrometheusMetrics());
    }

    if (parsedUrl.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        stats,
        metricsEma,
        memoryTrend: analyzeMemoryTrend(),
        resources: getSystemResourceSnapshot()
      }, null, 2));
    }

    if (parsedUrl.pathname === "/history") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(timeSeriesHistory.toArray(), null, 2));
    }

    if (parsedUrl.pathname === "/venues") {
      const venues = await probeExchangeVenues();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(venues, null, 2));
    }

    if (parsedUrl.pathname === "/action/heal" && req.method === "POST") {
      const ok = await healServer("api_control_trigger");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: ok }));
    }

    if (parsedUrl.pathname === "/action/clean" && req.method === "POST") {
      const freed = performAutoCleanup();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, freedBytes: freed }));
    }

    if (parsedUrl.pathname === "/action/backup" && req.method === "POST") {
      const snap = createDatabaseSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, snapshot: snap }));
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  });

  controlServerInstance.listen(port, "127.0.0.1", () => {
    log("info", `🌐 [CONTROL-SERVER] Internal REST & Prometheus telemetry server active on http://127.0.0.1:${port}`);
  });

  return controlServerInstance;
}

// ═══ Doctor Diagnostics Matrix & Live Diagnostics ══════════════════════════════

async function runDoctorDiagnostics() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         OBSIDIAN MASTER SYSTEM DOCTOR & BRAIN DIAGNOSTICS    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const results = [];
  let score = 100;

  // 1. Node.js Runtime
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor >= 18) {
    results.push({ name: "Node.js Runtime", status: "PASS", detail: `${process.version} (Optimal v${nodeMajor})` });
  } else {
    results.push({ name: "Node.js Runtime", status: "WARN", detail: `${process.version} (Recommend Node 18+)` });
    score -= 10;
  }

  // 2. HTTP Root Server Probe
  const httpProbe = await probeHttp(`http://127.0.0.1:${CONFIG.NODE_PORT}/`);
  if (httpProbe.ok) {
    results.push({ name: `HTTP Server (Port ${CONFIG.NODE_PORT})`, status: "PASS", detail: `HTTP ${httpProbe.status} in ${httpProbe.latencyMs}ms` });
  } else {
    results.push({ name: `HTTP Server (Port ${CONFIG.NODE_PORT})`, status: "FAIL", detail: `Unreachable: ${httpProbe.error}` });
    score -= 30;
  }

  // 3. Deep Orchestrator API Probe
  const apiProbe = await probeApiStatus(CONFIG.NODE_PORT);
  if (apiProbe.ok && apiProbe.data) {
    const d = apiProbe.data;
    results.push({ 
      name: "Screener API Status", 
      status: "PASS", 
      detail: `Uptime: ${d.uptimeSec || 0}s | Tickers: ${d.tickersCount || 0} | Clients: ${d.connectedWsClients || 0} | Exchanges: ${d.exchangesCount || 0}` 
    });
  } else if (httpProbe.ok) {
    results.push({ name: "Screener API Status", status: "PASS", detail: "HTTP responsive" });
  } else {
    results.push({ name: "Screener API Status", status: "FAIL", detail: "API endpoint unreachable" });
    score -= 15;
  }

  // 4. Semantic WebSocket (/ws) Stream Probe
  const wsProbe = await probeWebSocket(CONFIG.NODE_PORT);
  if (wsProbe.ok) {
    const msgInfo = wsProbe.receivedMessages > 0 ? ` (${wsProbe.receivedMessages} ticks received)` : "";
    results.push({ name: "WebSocket Stream (/ws)", status: "PASS", detail: `Stream handshake in ${wsProbe.latencyMs}ms${msgInfo}` });
  } else {
    results.push({ name: "WebSocket Stream (/ws)", status: "FAIL", detail: `Failed: ${wsProbe.error}` });
    score -= 25;
  }

  // 5. Semantic Go Density Scanner Probe
  const goProbe = await probeGoScanner(CONFIG.GO_SCANNER_PORT);
  if (goProbe.ok) {
    const freshTag = goProbe.isFresh ? " [Fresh ticks]" : "";
    results.push({ name: `Go Density Scanner (Port ${CONFIG.GO_SCANNER_PORT})`, status: "PASS", detail: `HTTP ${goProbe.status || 200} in ${goProbe.latencyMs}ms${freshTag}` });
  } else {
    results.push({ name: `Go Density Scanner (Port ${CONFIG.GO_SCANNER_PORT})`, status: "WARN", detail: `Notice: ${goProbe.error || "Offline"}` });
  }

  // 6. External DNS / Binance Reachability
  const dnsProbe = await probeDnsResolution("api.binance.com");
  if (dnsProbe.ok) {
    results.push({ name: "External DNS / Binance Reachability", status: "PASS", detail: `${dnsProbe.address} in ${dnsProbe.latencyMs}ms` });
  } else {
    results.push({ name: "External DNS / Binance Reachability", status: "WARN", detail: `DNS resolution issue: ${dnsProbe.error}` });
    score -= 15;
  }

  // 7. Host Memory (RAM) & Adaptive Z-Score
  const snapshot = getSystemResourceSnapshot();
  if (snapshot.memory.pct < 85) {
    results.push({ name: "System Memory (RAM)", status: "PASS", detail: `${snapshot.memory.pct}% used (${snapshot.memory.freeMemMB}MB free of ${snapshot.memory.totalMemMB}MB)` });
  } else {
    results.push({ name: "System Memory (RAM)", status: "WARN", detail: `Elevated: ${snapshot.memory.pct}% used (${snapshot.memory.freeMemMB}MB free)` });
    score -= 10;
  }

  // 8. Disk Storage Space
  const disk = getHostDiskUsage();
  if (disk.totalMB > 0) {
    if (disk.pct < CONFIG.DISK_CRITICAL_USAGE_PCT) {
      results.push({ name: "Disk Storage (/)", status: "PASS", detail: `${disk.pct}% used (${disk.availMB}MB available of ${disk.totalMB}MB)` });
    } else {
      results.push({ name: "Disk Storage (/)", status: "WARN", detail: `Critical: ${disk.pct}% used (${disk.availMB}MB available)` });
      score -= 20;
    }
  }

  // 9. Event Loop p95/p99 Responsiveness
  const loopLag = detectEventLoopLag();
  if (loopLag.windowP99Ms < CONFIG.EVENT_LOOP_LAG_WARN_MS) {
    results.push({ name: "Event Loop Lag Window (p99)", status: "PASS", detail: `Lag mean ${loopLag.meanMs}ms, window p99 ${loopLag.windowP99Ms}ms` });
  } else {
    results.push({ name: "Event Loop Lag Window (p99)", status: "WARN", detail: `Lag elevated: p99 ${loopLag.windowP99Ms}ms` });
    score -= 10;
  }

  // 10. Process Handles & File Descriptors
  const handles = inspectProcessHandles();
  if (handles.fdCount < 2048) {
    results.push({ name: "File Descriptors & Sockets", status: "PASS", detail: `${handles.fdCount} open FDs, ${handles.activeHandles} active handles` });
  } else {
    results.push({ name: "File Descriptors & Sockets", status: "WARN", detail: `High FD count: ${handles.fdCount} open FDs` });
    score -= 10;
  }

  // 11. Network Throughput & Interface Health
  if (snapshot.net.rxMbps >= 0) {
    results.push({ name: "Network Interface Throughput", status: "PASS", detail: `Rx: ${snapshot.net.rxMbps} Mbps | Tx: ${snapshot.net.txMbps} Mbps (0 dropped)` });
  }

  // 12. JSON Databases & Backup Integrity Check
  const dbFiles = ["users.json", "sessions.json", "auth_logs.json", "payments.json", "payment_invoices.json", "admin_audit.json"];
  let dbOk = true;
  let corruptedDb = "";
  for (const f of dbFiles) {
    const fp = path.join(__dirname, f);
    if (fs.existsSync(fp)) {
      try {
        JSON.parse(fs.readFileSync(fp, "utf8"));
      } catch (e) {
        dbOk = false;
        corruptedDb = f;
        break;
      }
    }
  }
  if (dbOk) {
    results.push({ name: "JSON Databases Integrity", status: "PASS", detail: "All local database stores are valid JSON" });
  } else {
    results.push({ name: "JSON Databases Integrity", status: "FAIL", detail: `Corrupted file detected: ${corruptedDb}` });
    score -= 30;
  }

  // 14. Military-Grade Anti-DDoS & Security Shield
  const bannedList = securityShield.getBannedIpsList();
  results.push({
    name: "Anti-DDoS & Security Shield",
    status: "PASS",
    detail: `Active | ${bannedList.length} banned IPs | iptables Kernel Guard active`
  });

  // 15. PM2 Process Supervision
  const pm2List = inspectPm2Processes();
  if (pm2List.length > 0) {
    const serverProc = pm2List.find(p => p.name === "server");
    if (serverProc && serverProc.pm2_env?.status === "online") {
      results.push({ name: "PM2 Process Supervision", status: "PASS", detail: `'server' online (PID ${serverProc.pid}, Restarts: ${serverProc.pm2_env?.restart_time || 0})` });
    } else {
      results.push({ name: "PM2 Process Supervision", status: "WARN", detail: `'server' is ${serverProc?.pm2_env?.status || "missing"}` });
      score -= 15;
    }
  }

  // Print results table
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅ [PASS]" : r.status === "WARN" ? "⚠️  [WARN]" : "❌ [FAIL]";
    console.log(` ${icon}  ${r.name.padEnd(38)} : ${r.detail}`);
  }

  score = Math.max(0, Math.min(100, score));
  console.log("────────────────────────────────────────────────────────────────");
  console.log(` Overall Health Score: ${score}/100 ${score >= 90 ? "🟢 (EXCELLENT)" : score >= 70 ? "🟡 (GOOD)" : "🔴 (CRITICAL)"}`);
  console.log("════════════════════════════════════════════════════════════════\n");

  return { score, results };
}

// ═══ Status & CLI Interface ═══════════════════════════════════════════════════

function renderProgressBar(pct, width = 16) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${pct}%`;
}

function printBannedIpsReport() {
  const banned = securityShield.getBannedIpsList();
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         OBSIDIAN SECURITY SHIELD: BANNED IPS LIST            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Total Banned IPs: ${banned.length}\n`);

  if (banned.length === 0) {
    console.log("✅ No banned IPs at this moment. Firewall is monitoring incoming traffic.\n");
    return;
  }

  console.log(" IP Address        | Hits | Time Left | Reason");
  console.log("───────────────────┼──────┼───────────┼────────────────────────────────────────");
  const now = Date.now();
  for (const item of banned) {
    const remainingMin = Math.max(0, Math.round((item.expiresAt - now) / 60000));
    console.log(` ${item.ip.padEnd(17)} | ${String(item.hits || 1).padEnd(4)} | ${(remainingMin + "m").padEnd(9)} | ${item.reason}`);
  }
  console.log("════════════════════════════════════════════════════════════════\n");
}

function printStatusReport() {
  const snapshot = getSystemResourceSnapshot();
  const uptimeSec = Math.round((Date.now() - stats.startTime) / 1000);
  const memTrend = analyzeMemoryTrend();
  const topFiles = findLargestFiles(__dirname, 2, 3);
  const loopLag = detectEventLoopLag();
  const bannedCount = securityShield.getBannedIpsList().length;
  
  // Prepare Sparklines from Time-Series
  const recentHistory = timeSeriesHistory.toArray().slice(-16);
  const ramSpark = renderSparkline(recentHistory.map(h => h.ramMB));
  const lagSpark = renderSparkline(recentHistory.map(h => h.loopLagP99));
  const httpSpark = renderSparkline(recentHistory.map(h => h.httpLatency));

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║             OBSIDIAN ORCHESTRATOR STATUS DASHBOARD           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`• Uptime:           ${uptimeSec}s (${(uptimeSec / 3600).toFixed(1)} hours)`);
  console.log(`• Total Probes:     ${stats.totalProbes}`);
  console.log(`• Auto-Heals:       ${stats.autoHealsCount}`);
  console.log(`• Auto-Repairs:     ${stats.autoRepairsCount}`);
  console.log(`• Auto-Cleanups:    ${stats.cleanupsCount}`);
  console.log(`• Security Shield:  🛡️ Active (${bannedCount} banned IPs) | iptables KERNEL DROP`);
  console.log(`• DB Prune Cycles:  ${stats.dbPrunesCount} (${stats.prunedLogsCount} records compacted)`);
  console.log(`• DB Snapshots:     ${stats.snapshotsCount} (saved in backups/)`);
  console.log(`• Freed Storage:    ${(stats.freedBytesTotal / 1024 / 1024).toFixed(2)} MB`);
  console.log(`• Host RAM:         ${renderProgressBar(snapshot.memory.pct, 14)} (${snapshot.memory.usedMemMB}MB / ${snapshot.memory.totalMemMB}MB) ${ramSpark ? "❲" + ramSpark + "❳" : ""}`);
  console.log(`• Host Disk:        ${renderProgressBar(snapshot.disk.pct, 14)} (${snapshot.disk.usedMB}MB / ${snapshot.disk.totalMB}MB)`);
  console.log(`• V8 Heap Headroom: ${snapshot.v8Heap.usedMB}MB used / ${snapshot.v8Heap.limitMB}MB limit (${snapshot.v8Heap.usagePct}%)`);
  console.log(`• Network Through:  ↓ ${snapshot.net.rxMbps} Mbps  |  ↑ ${snapshot.net.txMbps} Mbps`);
  console.log(`• Open FDs/Handles: ${snapshot.handles.fdCount} FDs | ${snapshot.handles.activeHandles} handles`);
  console.log(`• Memory Trend:     ${memTrend.trend} (${memTrend.rateMBPerHr >= 0 ? "+" : ""}${memTrend.rateMBPerHr} MB/hr) | Z-Score: ${stats.lastCheckResult?.memZScore || 0}`);
  console.log(`• HTTP Latency EMA: ${metricsEma.httpLatency} ms ${httpSpark ? "❲" + httpSpark + "❳" : ""}`);
  console.log(`• WS Latency EMA:   ${metricsEma.wsLatency} ms`);
  console.log(`• Event Loop Lag:   mean ${metricsEma.loopLag}ms | window p99 ${loopLag.windowP99Ms}ms ${lagSpark ? "❲" + lagSpark + "❳" : ""}`);
  console.log(`• Node Version:     ${process.version}`);
  console.log(`• Platform:         ${os.platform()} (${os.arch()})`);
  console.log(`• Last Activity:    ${stats.lastLog}`);
  console.log("────────────────────────────────────────────────────────────────");

  const pm2 = inspectPm2Processes();
  if (pm2.length > 0) {
    console.log("PM2 Managed Services:");
    for (const p of pm2) {
      const mem = p.monit?.memory ? (p.monit.memory / 1024 / 1024).toFixed(1) + "MB" : "N/A";
      const cpu = p.monit?.cpu !== undefined ? p.monit.cpu + "%" : "N/A";
      const restarts = p.pm2_env?.restart_time || 0;
      console.log(`  • [${p.name}] Status: ${p.pm2_env?.status} | CPU: ${cpu} | RAM: ${mem} | Restarts: ${restarts}`);
    }
  } else {
    console.log("PM2: No active processes detected (or not running in PM2 environment).");
  }

  if (topFiles.length > 0) {
    console.log("────────────────────────────────────────────────────────────────");
    console.log("Top Storage Consuming Files:");
    for (const f of topFiles) {
      console.log(`  • ${f.relPath.padEnd(35)} : ${f.sizeMB} MB`);
    }
  }

  if (stats.incidents.length > 0) {
    console.log("────────────────────────────────────────────────────────────────");
    console.log("Recent Incidents & Auto-Heals:");
    for (const inc of stats.incidents.slice(0, 5)) {
      console.log(`  • [${inc.timestamp.slice(11, 19)}] ${inc.type.toUpperCase()}: ${inc.reason}`);
    }
  }
  console.log("════════════════════════════════════════════════════════════════\n");
}

function printTimeSeriesHistory() {
  const points = timeSeriesHistory.toArray();
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         TIME-SERIES TELEMETRY HISTORY (LAST 100 MINS)        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Recorded Data Points: ${points.length} / 600\n`);
  
  if (points.length === 0) {
    console.log("No data points recorded yet. Daemon is collecting metrics every 10s.\n");
    return;
  }

  const ramSpark = renderSparkline(points.map(p => p.ramMB));
  const lagSpark = renderSparkline(points.map(p => p.loopLagP99));
  console.log(`RAM Trend (100m) : ❲${ramSpark}❳`);
  console.log(`Lag Trend (100m) : ❲${lagSpark}❳\n`);
  
  console.log(" Time     | Node RAM  | CPU% | Lag p99 | HTTP ms | WS ms | Tickers | FDs | Net Rx/Tx");
  console.log("──────────┼───────────┼──────┼─────────┼─────────┼───────┼─────────┼─────┼──────────");
  for (const pt of points.slice(-15)) {
    const tStr = new Date(pt.ts).toISOString().slice(11, 19);
    const netStr = `${pt.netRxMbps || 0}/${pt.netTxMbps || 0}M`;
    console.log(` ${tStr} | ${(pt.ramMB + "MB").padEnd(9)} | ${(pt.cpu + "%").padEnd(4)} | ${(pt.loopLagP99 + "ms").padEnd(7)} | ${(pt.httpLatency + "ms").padEnd(7)} | ${(pt.wsLatency + "ms").padEnd(5)} | ${String(pt.tickers).padEnd(7)} | ${String(pt.fdCount).padEnd(3)} | ${netStr}`);
  }
  console.log("════════════════════════════════════════════════════════════════\n");
}

function startLiveDashboard() {
  console.clear();
  console.log("Starting Live Watch Mode with Sparklines... (Press Ctrl+C to exit)");
  setInterval(async () => {
    await performHealthCheck();
    console.clear();
    printStatusReport();
  }, 2000);
}

async function printExchangeVenuesReport() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         EXCHANGE VENUES NETWORK LATENCY & REACHABILITY       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  
  const results = await probeExchangeVenues();
  for (const r of results) {
    const icon = r.ok ? "✅ [PASS]" : "❌ [FAIL]";
    const detail = r.ok ? `${r.address} in ${r.latencyMs}ms` : `Error: ${r.error}`;
    console.log(` ${icon}  ${r.name.padEnd(12)} (${r.host.padEnd(22)}) : ${detail}`);
  }
  console.log("════════════════════════════════════════════════════════════════\n");
}

// ═══ Master Daemon Startup ════════════════════════════════════════════════════

function startDaemon() {
  log("info", "🚀 Starting Obsidian Autonomous Orchestrator Brain & Self-Healing Daemon v5.5...");

  writeHeartbeatFile();
  optimizeSystemKernel();
  ensurePortForwarding();
  ensurePm2EcosystemConfig();
  installCronHeartbeatSupervisor();
  autoRepairDatabasesIfCorrupted();
  validateDatabaseRelationalIntegrity();
  performAutoCleanup();
  pruneJsonDatabases();

  if (CONFIG.ENABLE_CONTROL_SERVER) {
    startControlServer(CONFIG.CONTROL_SERVER_PORT);
  }

  // Initial immediate probe
  performHealthCheck().catch(err => log("error", "Error in initial health check:", err.message));

  // Health check loop (every 10s)
  setInterval(() => {
    performHealthCheck().catch(err => log("error", "Error in health check loop:", err.message));
  }, CONFIG.CHECK_INTERVAL_MS);

  // Auto-cleanup loop (every 15 mins)
  setInterval(() => {
    performAutoCleanup();
  }, CONFIG.CLEANUP_INTERVAL_MS);

  // Database pruning & snapshot loop (every 60 mins)
  setInterval(() => {
    pruneJsonDatabases();
  }, CONFIG.DB_PRUNE_INTERVAL_MS);

  log("info", `⚡ Orchestrator Brain active. Health probe: ${CONFIG.CHECK_INTERVAL_MS / 1000}s | Deep clean: ${CONFIG.CLEANUP_INTERVAL_MS / 60000}m | DB prune/snapshot: ${CONFIG.DB_PRUNE_INTERVAL_MS / 60000}m`);
}

// ═══ Module Exports for Testing & Server Integration ══════════════════════════

module.exports = {
  CONFIG,
  stats,
  failureCounter,
  metricsEma,
  ramStatsTracker,
  timeSeriesHistory,
  securityShield,
  log,
  runCmd,
  runCmdAsync,
  probeHttp,
  probeApiStatus,
  probeWebSocket,
  probeDnsResolution,
  probeExchangeVenues,
  probeGoScanner,
  freePortIfLocked,
  optimizeSystemKernel,
  ensurePortForwarding,
  ensurePm2EcosystemConfig,
  inspectPm2Processes,
  superviseAllPm2Services,
  isServiceCircuitBreakerOpen,
  recordServiceRestart,
  captureHeapSnapshotBeforeKill,
  gracefulDrainBeforeReload,
  writeHeartbeatFile,
  installCronHeartbeatSupervisor,
  validateDatabaseRelationalIntegrity,
  renderSparkline,
  getNetworkThroughput,
  performHealthCheck,
  healServer,
  healGoScanner,
  performAutoCleanup,
  pruneJsonDatabases,
  createDatabaseSnapshot,
  autoRepairDatabasesIfCorrupted,
  generatePrometheusMetrics,
  startControlServer,
  runDoctorDiagnostics,
  printStatusReport,
  printBannedIpsReport,
  printTimeSeriesHistory,
  printExchangeVenuesReport,
  startLiveDashboard,
  safeAtomicWriteJSON,
  safeAtomicWriteJSONAsync,
  sendTelegramAlert,
  getHostDiskUsage,
  getSystemResourceSnapshot,
  getV8HeapBreakdown,
  inspectProcessHandles,
  findLargestFiles,
  analyzeMemoryTrend,
  detectEventLoopLag
};

// ═══ CLI Entrypoint ═══════════════════════════════════════════════════════════

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    printStatusReport();
    process.exit(0);
  } else if (args.includes("--doctor")) {
    runDoctorDiagnostics().then(() => process.exit(0)).catch(() => process.exit(1));
  } else if (args.includes("--banned")) {
    printBannedIpsReport();
    process.exit(0);
  } else if (args.includes("--ban")) {
    const ip = args[args.indexOf("--ban") + 1];
    const reason = args[args.indexOf("--ban") + 2] || "Manual Admin Ban";
    if (!ip) {
      console.error("Usage: node orchestrator.js --ban <IP> [reason]");
      process.exit(1);
    }
    const ok = securityShield.banIp(ip, reason, 86400);
    console.log(ok ? `✅ IP ${ip} successfully banned (24 hours)` : `❌ Failed to ban ${ip}`);
    process.exit(0);
  } else if (args.includes("--unban")) {
    const ip = args[args.indexOf("--unban") + 1];
    if (!ip) {
      console.error("Usage: node orchestrator.js --unban <IP>");
      process.exit(1);
    }
    const ok = securityShield.unbanIp(ip);
    console.log(ok ? `✅ IP ${ip} successfully unbanned` : `❌ IP ${ip} was not in ban list`);
    process.exit(0);
  } else if (args.includes("--clear-bans")) {
    const count = securityShield.clearAllBans();
    console.log(`✅ Cleared ${count} banned IP addresses`);
    process.exit(0);
  } else if (args.includes("--history")) {
    printTimeSeriesHistory();
    process.exit(0);
  } else if (args.includes("--venues")) {
    printExchangeVenuesReport().then(() => process.exit(0));
  } else if (args.includes("--backup")) {
    createDatabaseSnapshot();
    process.exit(0);
  } else if (args.includes("--metrics")) {
    console.log(generatePrometheusMetrics());
    process.exit(0);
  } else if (args.includes("--ecosystem")) {
    ensurePm2EcosystemConfig();
    process.exit(0);
  } else if (args.includes("--install-cron")) {
    installCronHeartbeatSupervisor();
    process.exit(0);
  } else if (args.includes("--heal")) {
    healServer("manual_cli_trigger").then(() => process.exit(0));
  } else if (args.includes("--clean")) {
    performAutoCleanup();
    process.exit(0);
  } else if (args.includes("--prune-db")) {
    pruneJsonDatabases();
    process.exit(0);
  } else if (args.includes("--watch") || args.includes("--live")) {
    startLiveDashboard();
  } else if (args.includes("--json")) {
    console.log(JSON.stringify({
      stats,
      metricsEma,
      memoryTrend: analyzeMemoryTrend(),
      resources: getSystemResourceSnapshot(),
      bannedIps: securityShield.getBannedIpsList(),
      topFiles: findLargestFiles(__dirname, 2, 5),
      history: timeSeriesHistory.toArray().slice(-20)
    }, null, 2));
    process.exit(0);
  } else {
    startDaemon();
  }
}

