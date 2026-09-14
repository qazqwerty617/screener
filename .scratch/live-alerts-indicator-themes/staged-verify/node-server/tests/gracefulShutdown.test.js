"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// Graceful shutdown ordering.
//
// The formation cooldowns exist to survive the frequent restarts (memory
// ceiling, deploys, auto-heal). They were never actually flushed:
// `correlationEngine.init()` runs during `require("./correlationEngine")` — long
// before server.js reaches its own signal wiring — and it registered
// `process.once("SIGTERM", () => { cleanup(); process.exit(); })`. Node runs
// signal listeners in registration order, so `process.exit()` in the first
// listener killed the process before `saveFormationCooldowns(true)` could run.
//
// These tests pin the invariants that keep that from regressing.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SERVER_SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const CORR_SRC = fs.readFileSync(path.join(__dirname, "..", "correlationEngine.js"), "utf8");

test("no module registers a signal handler that exits the process", () => {
  // A module loaded via require() always wins the ordering race against
  // server.js's own handler, so none of them may call process.exit from one.
  const dir = path.join(__dirname, "..");
  const offenders = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".js") || file === "server.js" || file === "orchestrator.js") continue;
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    // Look for a SIGINT/SIGTERM registration whose body reaches process.exit.
    const re = /process\.(?:on|once)\(\s*["'](?:SIGINT|SIGTERM)["'][^)]*?process\.exit/gs;
    if (re.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `these modules exit from a signal handler: ${offenders.join(", ")}`);
});

test("correlationEngine only hooks exit, never the termination signals", () => {
  assert.match(CORR_SRC, /process\.once\("exit"/, "must still persist on exit");
  assert.ok(
    !/process\.(on|once)\(\s*["']SIG(INT|TERM)["']/.test(CORR_SRC),
    "correlationEngine must not claim SIGINT/SIGTERM — server.js owns shutdown ordering"
  );
});

test("correlationEngine exposes the hooks the shutdown path calls", () => {
  const engine = require("../correlationEngine");
  assert.equal(typeof engine.saveCacheSync, "function", "shutdown calls saveCacheSync()");
  assert.equal(typeof engine.stop, "function", "shutdown calls stop()");
});

test("server.js owns a single ordered shutdown path", () => {
  assert.match(SERVER_SRC, /function gracefulShutdown\(signal\)/);
  // Re-entrancy guard: pm2 can send SIGINT then SIGTERM.
  assert.match(SERVER_SRC, /let shuttingDown = false;/);
  assert.match(SERVER_SRC, /if \(shuttingDown\) return;/);

  const body = /function gracefulShutdown\(signal\) \{([\s\S]*?)\n  \}/.exec(SERVER_SRC);
  assert.ok(body, "gracefulShutdown body must be locatable");
  const b = body[1];

  // Persistence must happen before anything that can end the process.
  const iFlush = b.indexOf("saveFormationCooldowns(true)");
  const iCorr = b.indexOf("saveCacheSync");
  const iClose = b.indexOf("server.close()");
  const iExit = b.indexOf("process.exit");
  assert.ok(iFlush > -1, "must flush formation cooldowns");
  assert.ok(iCorr > -1, "must flush correlation cache");
  assert.ok(iClose > -1, "must stop accepting connections");
  assert.ok(iFlush < iClose, "flush cooldowns before closing the server");
  assert.ok(iCorr < iClose, "flush correlations before closing the server");
  assert.ok(iExit > iClose, "process.exit must come last");

  // Both signals route through the one handler.
  assert.match(SERVER_SRC, /for \(const sig of \["SIGINT", "SIGTERM"\]\) \{\s*\r?\n\s*process\.on\(sig, \(\) => gracefulShutdown\(sig\)\);/);
});

test("the shutdown flush is synchronous, the throttled autosave is not", () => {
  // `force` = shutdown: async I/O would never complete. Throttled = hot loop:
  // a blocking write of up to 40k entries stalls the event loop.
  assert.match(SERVER_SRC, /if \(force\) \{[\s\S]*?fs\.writeFileSync\(tmp, json, "utf8"\);[\s\S]*?fs\.renameSync\(tmp, FORMATION_COOLDOWN_FILE\);/);
  assert.match(SERVER_SRC, /fs\.writeFile\(tmp, json, "utf8", \(err\) => \{/);
});

test("shutdown exits well inside pm2's kill_timeout", () => {
  const eco = require("../ecosystem.config.js");
  const app = eco.apps.find(a => a.script === "server.js");
  const killTimeout = app.kill_timeout || 1600;
  const m = /setTimeout\(\(\) => process\.exit\(0\), (\d+)\)/.exec(SERVER_SRC);
  assert.ok(m, "shutdown must have a hard exit deadline");
  assert.ok(
    Number(m[1]) < killTimeout,
    `exit deadline ${m[1]}ms must be under pm2 kill_timeout ${killTimeout}ms or state is lost to SIGKILL`
  );
});
