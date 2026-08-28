"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const orchestrator = require("../orchestrator");
const securityShield = require("../securityShield");

process.env.NODE_ENV = "test";

test("securityShield - whitelist protects localhost and private IPs", () => {
  assert.equal(securityShield.isPrivateOrLocalIp("127.0.0.1"), true);
  assert.equal(securityShield.isPrivateOrLocalIp("::1"), true);
  assert.equal(securityShield.isPrivateOrLocalIp("192.168.1.100"), true);
  assert.equal(securityShield.isPrivateOrLocalIp("10.0.0.5"), true);
  assert.equal(securityShield.isPrivateOrLocalIp("185.220.101.5"), false);
});

test("securityShield - multi-user and multi-tab WebSocket tolerance", () => {
  const sharedIp = "198.51.100.77";
  // Allows up to 50 concurrent tabs/users on the same IP
  for (let i = 0; i < 40; i++) {
    const ok = securityShield.registerWsConnection(sharedIp);
    assert.equal(ok, true, `Connection ${i + 1} from shared IP should be permitted`);
  }
  // Clean up
  for (let i = 0; i < 40; i++) {
    securityShield.unregisterWsConnection(sharedIp);
  }
});

test("securityShield - ban, lookup, and unban lifecycle", () => {
  const testIp = "203.0.113.199";
  assert.equal(securityShield.isIpBanned(testIp), false);

  const banned = securityShield.banIp(testIp, "Unit Test Attack", 3600);
  assert.equal(banned, true);
  assert.equal(securityShield.isIpBanned(testIp), true);

  const unbanned = securityShield.unbanIp(testIp);
  assert.equal(unbanned, true);
  assert.equal(securityShield.isIpBanned(testIp), false);
});

test("securityShield - middleware catches scanner bots with strike accumulation", () => {
  const testIp = "198.51.100.88";
  
  // Strike 1 to 4: Soft 403, NOT banned yet
  for (let i = 1; i <= 4; i++) {
    let blocked = false;
    let statusCode = 200;
    const req = { ip: testIp, originalUrl: "/wp-login.php", url: "/wp-login.php" };
    const res = {
      setHeader: () => {},
      status: (code) => { statusCode = code; return { send: () => { blocked = true; } }; }
    };
    securityShield.securityShieldMiddleware(req, res, () => {});
    assert.equal(blocked, true);
    assert.equal(statusCode, 403);
    assert.equal(securityShield.isIpBanned(testIp), false, `Should not ban on strike ${i}`);
  }

  // Strike 5: Aggressive repeated bot -> Triggers BAN
  const req = { ip: testIp, originalUrl: "/wp-login.php", url: "/wp-login.php" };
  const res = {
    setHeader: () => {},
    status: () => ({ send: () => {} })
  };
  securityShield.securityShieldMiddleware(req, res, () => {});
  assert.equal(securityShield.isIpBanned(testIp), true, "Should ban after 5 strikes");

  // Clean up
  securityShield.unbanIp(testIp);
});

test("orchestrator - atomic json write creates valid file with correct contents", () => {
  const tmpFile = path.join(os.tmpdir(), `orch_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    const data = { testKey: "testVal", num: 12345, arr: [1, 2, 3] };
    const ok = orchestrator.safeAtomicWriteJSON(tmpFile, data);
    assert.equal(ok, true, "atomic write should succeed");
    assert.equal(fs.existsSync(tmpFile), true, "target file should exist");
    
    const readBack = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    assert.deepEqual(readBack, data, "read data should match written data");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

test("orchestrator - async atomic json write creates valid file with backup", async () => {
  const tmpFile = path.join(os.tmpdir(), `orch_async_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    const dataInitial = { version: 1 };
    await orchestrator.safeAtomicWriteJSONAsync(tmpFile, dataInitial, false);
    assert.equal(fs.existsSync(tmpFile), true);

    const dataUpdated = { version: 2, status: "updated" };
    const ok = await orchestrator.safeAtomicWriteJSONAsync(tmpFile, dataUpdated, true);
    assert.equal(ok, true);

    const readBack = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    assert.deepEqual(readBack, dataUpdated);
    assert.equal(fs.existsSync(`${tmpFile}.bak`), true, "backup .bak file should exist");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.unlinkSync(`${tmpFile}.bak`); } catch (_) {}
  }
});

test("orchestrator - per-service restart circuit breaker prevents crash-loop", () => {
  const service = `test-service-${Date.now()}`;
  assert.equal(orchestrator.isServiceCircuitBreakerOpen(service), false);
  
  // Record 5 restarts
  for (let i = 1; i <= 5; i++) {
    orchestrator.recordServiceRestart(service);
  }
  
  assert.equal(orchestrator.isServiceCircuitBreakerOpen(service), true, "Circuit breaker should open after 5 restarts");
});

test("orchestrator - writes heartbeat file with valid timestamp", () => {
  orchestrator.writeHeartbeatFile();
  const heartbeatPath = orchestrator.CONFIG.HEARTBEAT_FILE;
  assert.equal(fs.existsSync(heartbeatPath), true);
  const content = fs.readFileSync(heartbeatPath, "utf8");
  assert.ok(content.includes(":"));
  const parts = content.split(":");
  assert.ok(parseInt(parts[0], 10) > 0);
});

test("orchestrator - renders ASCII sparkline graph", () => {
  const spark = orchestrator.renderSparkline([10, 20, 30, 40, 50, 40, 20, 10]);
  assert.ok(typeof spark === "string");
  assert.equal(spark.length, 8);
  assert.ok(spark.includes("█"));
  assert.ok(spark.includes(" "));
});

test("orchestrator - returns network throughput telemetry", () => {
  const net = orchestrator.getNetworkThroughput();
  assert.equal(typeof net.rxMbps, "number");
  assert.equal(typeof net.txMbps, "number");
  assert.equal(typeof net.dropped, "number");
});

test("orchestrator - validates database relational integrity", () => {
  const count = orchestrator.validateDatabaseRelationalIntegrity();
  assert.equal(typeof count, "number");
  assert.ok(count >= 0);
});

test("orchestrator - adaptive z-score calculates anomaly accurately", () => {
  const tracker = orchestrator.ramStatsTracker;
  for (let i = 0; i < 30; i++) {
    tracker.push(200 + (i % 5));
  }
  const zScoreNormal = tracker.calcZScore(205);
  assert.ok(zScoreNormal < 2.5, "Normal value should have low z-score");

  const zScoreSpike = tracker.calcZScore(600);
  assert.ok(zScoreSpike >= 3.0, "Large spike should have high z-score >= 3.0");
});

test("orchestrator - captures heap snapshot safely before process kill", () => {
  const snapFile = orchestrator.captureHeapSnapshotBeforeKill("orchestrator");
  assert.ok(snapFile);
  assert.equal(fs.existsSync(snapFile), true);
  try { fs.unlinkSync(snapFile); } catch (_) {}
});

test("orchestrator - inspects process handles and file descriptors", () => {
  const handles = orchestrator.inspectProcessHandles();
  assert.equal(typeof handles.activeHandles, "number");
  assert.equal(typeof handles.fdCount, "number");
  assert.ok(handles.activeHandles >= 0);
});

test("orchestrator - time series history records multi-vector data points", () => {
  const history = orchestrator.timeSeriesHistory;
  history.push({
    ts: Date.now(),
    ramMB: 150,
    cpu: 5,
    loopLagP99: 10,
    httpLatency: 25,
    wsLatency: 15,
    tickers: 10000,
    fdCount: 42
  });
  assert.ok(history.toArray().length > 0);
  assert.equal(history.latest.tickers, 10000);
});

test("orchestrator - probeHttp correctly reports success and measures latency", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await orchestrator.probeHttp(`http://127.0.0.1:${port}/`, 2000);
    assert.equal(result.ok, true, "probe should be ok");
    assert.equal(result.status, 200, "status code should be 200");
    assert.equal(typeof result.latencyMs, "number", "latency should be a number");
    assert.ok(result.latencyMs >= 0, "latency should be >= 0");
  } finally {
    server.close();
  }
});

test("orchestrator - probeApiStatus validates structured telemetry response", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/orchestrator/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        server: { uptimeSec: 42, tickersCount: 150, connectedWsClients: 5, exchangesCount: 4 }
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await orchestrator.probeApiStatus(port, 2000);
    assert.equal(result.ok, true, "API status probe should be ok");
    assert.ok(result.data, "API data should be returned");
    assert.equal(result.data.tickersCount, 150);
    assert.equal(result.data.connectedWsClients, 5);
  } finally {
    server.close();
  }
});

test("orchestrator - probeHttp handles unreachable ports without crashing", async () => {
  const result = await orchestrator.probeHttp("http://127.0.0.1:59199/nonexistent", 500);
  assert.equal(result.ok, false, "probe should fail for closed port");
  assert.ok(result.error, "should contain error message");
});

test("orchestrator - returns cross-platform disk usage and system snapshot", () => {
  const disk = orchestrator.getHostDiskUsage();
  assert.equal(typeof disk.totalMB, "number");
  assert.equal(typeof disk.usedMB, "number");
  assert.equal(typeof disk.availMB, "number");
  assert.equal(typeof disk.pct, "number");
  assert.ok(disk.pct >= 0 && disk.pct <= 100);

  const snapshot = orchestrator.getSystemResourceSnapshot();
  assert.ok(snapshot.memory);
  assert.ok(snapshot.v8Heap);
  assert.ok(snapshot.cpu);
  assert.ok(snapshot.disk);
  assert.ok(snapshot.handles);
  assert.ok(snapshot.net);
  assert.ok(snapshot.memory.totalMemMB > 0);
  assert.ok(snapshot.v8Heap.limitMB > 0);
});

test("orchestrator - returns v8 heap breakdown statistics", () => {
  const heap = orchestrator.getV8HeapBreakdown();
  assert.equal(typeof heap.usedMB, "number");
  assert.equal(typeof heap.totalMB, "number");
  assert.equal(typeof heap.limitMB, "number");
  assert.ok(heap.limitMB > 0);
});

test("orchestrator - detectEventLoopLag measures loop responsiveness and rolling percentiles", () => {
  const lag = orchestrator.detectEventLoopLag();
  assert.equal(typeof lag.meanMs, "number");
  assert.equal(typeof lag.p50Ms, "number");
  assert.equal(typeof lag.p95Ms, "number");
  assert.equal(typeof lag.p99Ms, "number");
  assert.equal(typeof lag.windowP99Ms, "number");
  assert.ok(lag.meanMs >= 0);
});

test("orchestrator - creates unified database snapshot and cleans up old ones", () => {
  const res = orchestrator.createDatabaseSnapshot();
  assert.ok(res.backupFile);
  assert.equal(fs.existsSync(res.backupFile), true);
  assert.ok(res.storesCount >= 0);

  const snapshotData = JSON.parse(fs.readFileSync(res.backupFile, "utf8"));
  assert.equal(snapshotData.version, "5.5");
  assert.ok(snapshotData.timestamp);
});

test("orchestrator - finds largest files on disk", () => {
  const largest = orchestrator.findLargestFiles(path.join(__dirname, ".."), 2, 5);
  assert.ok(Array.isArray(largest));
  assert.ok(largest.length > 0);
  assert.ok(largest[0].sizeMB >= 0);
});

test("orchestrator - analyzes memory trends and detects leaks", () => {
  const trend = orchestrator.analyzeMemoryTrend();
  assert.ok(trend.trend);
  assert.equal(typeof trend.rateMBPerHr, "number");
  assert.equal(typeof trend.leakSuspected, "boolean");
});

test("orchestrator - probes exchange venues DNS & latency", async () => {
  const venues = await orchestrator.probeExchangeVenues();
  assert.ok(Array.isArray(venues));
  assert.ok(venues.length >= 4);
  for (const v of venues) {
    assert.ok(v.name);
    assert.ok(v.host);
    assert.equal(typeof v.latencyMs, "number");
  }
});

test("orchestrator - generates valid Prometheus format metrics", () => {
  const metrics = orchestrator.generatePrometheusMetrics();
  assert.ok(typeof metrics === "string");
  assert.ok(metrics.includes("orchestrator_uptime_seconds"));
  assert.ok(metrics.includes("orchestrator_http_latency_ms"));
  assert.ok(metrics.includes("orchestrator_memory_used_bytes"));
  assert.ok(metrics.includes("orchestrator_disk_used_percent"));
});

test("orchestrator - autoRepairDatabasesIfCorrupted runs safely", () => {
  const count = orchestrator.autoRepairDatabasesIfCorrupted();
  assert.equal(typeof count, "number");
});

test("orchestrator - performs database compaction and cleanup without throwing", () => {
  const freed = orchestrator.performAutoCleanup();
  assert.equal(typeof freed, "number", "performAutoCleanup should return freed bytes as number");

  const pruned = orchestrator.pruneJsonDatabases();
  assert.equal(typeof pruned, "number", "pruneJsonDatabases should return pruned entries count as number");
});

test("orchestrator - doctor diagnostics completes and returns health score", async () => {
  const doc = await orchestrator.runDoctorDiagnostics();
  assert.ok(doc, "doctor diagnostics should return an object");
  assert.equal(typeof doc.score, "number", "health score should be a number");
  assert.ok(doc.score >= 0 && doc.score <= 100, "health score should be between 0 and 100");
  assert.ok(Array.isArray(doc.results), "results should be an array");
  assert.ok(doc.results.length >= 8, "should evaluate at least 8 subsystem vectors");
});
