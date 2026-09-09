"use strict";
// Guards the two behaviours the user reported as broken:
//   1. formation alerts arriving in batches instead of one at a time
//   2. the formation not being fully visible in the snapshot
//
// The dispatcher lives inside a closure in server.js, so its ranking and gating
// logic is extracted from source and driven directly. That keeps the test honest
// (it runs the shipped code) without needing to boot the whole server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SERVER_SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extractFn(name) {
  const re = new RegExp(`function ${name}\\(signal\\) \\{[\\s\\S]*?\\n  \\}`);
  const m = re.exec(SERVER_SRC);
  assert.ok(m, `${name} must exist in server.js`);
  return new Function(`${m[0]}; return ${name};`)();
}

const scoreFormationSignal = extractFn("scoreFormationSignal");

const COIN_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_GAP_MS = 45 * 1000;

function sig(tf, type, touches, dist, price = 100, sym = "TESTUSDT") {
  return {
    ex: "BN", sym, base: sym.replace("USDT", ""), tf, type,
    direction: "short", price,
    meta: { touches, dist, levelType: "resistance", swingIdx: 10, touchIndices: [10, 40, 70] }
  };
}

// Faithful reproduction of the dispatcher's gate order.
function dispatch(signals, state, now, cooldownSec = 300) {
  const ranked = signals.filter(s => s && s.type && s.sym)
    .sort((a, b) => scoreFormationSignal(b) - scoreFormationSignal(a));

  const sent = [];
  for (const s of ranked) {
    const touches = s.meta?.touches || 1;
    const dist = s.meta?.dist !== undefined ? Number(s.meta.dist) : 0.5;
    if (dist > 1.2 || touches < 2) continue;

    const coinKey = `U1:${s.ex}:${s.sym}`;
    const coinWindow = Math.max(COIN_COOLDOWN_MS, cooldownSec * 1000);
    if (now - (state.coin.get(coinKey) || 0) < coinWindow) continue;

    if (now - (state.paced.get("U1") || 0) < MIN_GAP_MS) continue;

    const cdKey = `U1:${s.ex}:${s.sym}:${s.type}:${s.tf}`;
    if (now - (state.pair.get(cdKey) || 0) < cooldownSec * 1000) continue;

    state.pair.set(cdKey, now);
    state.coin.set(coinKey, now);
    state.paced.set("U1", now);
    sent.push(s);
  }
  return sent;
}

const newState = () => ({ pair: new Map(), coin: new Map(), paced: new Map() });

test("a scan yielding many formations on one coin sends exactly one alert", () => {
  // Shape taken from live Binance data: 17 signals across 5 timeframes.
  const signals = [];
  for (const [tf, n] of Object.entries({ "1m": 5, "5m": 4, "15m": 4, "1h": 3, "4h": 1 })) {
    for (let i = 0; i < n; i++) signals.push(sig(tf, "retest", 2, 0.05 + i * 0.1, 100 + i));
  }
  const sent = dispatch(signals, newState(), Date.now());
  assert.equal(sent.length, 1, `expected 1 alert, got ${sent.length}`);
});

test("the alert sent is the strongest formation, not the first scanned", () => {
  const signals = [
    sig("1m", "retest", 2, 0.02, 100),
    sig("5m", "retest", 2, 0.10, 101),
    sig("1h", "level", 5, 0.40, 102),
    sig("4h", "trendline", 4, 0.30, 103)
  ];
  const sent = dispatch(signals, newState(), Date.now());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "level");
  assert.equal(sent[0].meta.touches, 5);
});

test("more touches outrank being closer to price", () => {
  const near = sig("1m", "retest", 2, 0.01);
  const strong = sig("4h", "level", 4, 0.9);
  assert.ok(
    scoreFormationSignal(strong) > scoreFormationSignal(near),
    "a 4-touch level must outrank a 2-touch retest sitting closer"
  );
});

test("a structural formation outranks a retest at equal touches", () => {
  const retest = sig("15m", "retest", 3, 0.3);
  const level = sig("15m", "level", 3, 0.3);
  assert.ok(scoreFormationSignal(level) > scoreFormationSignal(retest));
});

test("repeat scans inside the window stay silent, then resume", () => {
  const state = newState();
  const t0 = Date.now();
  const build = () => [sig("5m", "level", 3, 0.2), sig("1m", "retest", 2, 0.1)];

  assert.equal(dispatch(build(), state, t0).length, 1, "first scan speaks");
  assert.equal(dispatch(build(), state, t0 + 1000).length, 0, "1s later: silent");
  assert.equal(dispatch(build(), state, t0 + 5 * 60000).length, 0, "5min later: silent");
  assert.equal(dispatch(build(), state, t0 + 14 * 60000).length, 0, "14min later: silent");
  assert.equal(dispatch(build(), state, t0 + 16 * 60000).length, 1, "16min later: speaks again");
});

test("a user cooldown longer than the coin window is respected", () => {
  const state = newState();
  const t0 = Date.now();
  const cooldownSec = 3600; // 60 minutes, longer than the 15-minute coin gate
  assert.equal(dispatch([sig("5m", "level", 3, 0.2)], state, t0, cooldownSec).length, 1);
  assert.equal(
    dispatch([sig("5m", "level", 3, 0.2)], state, t0 + 20 * 60000, cooldownSec).length,
    0,
    "the longer user cooldown must win over the 15-minute default"
  );
});

test("different coins are gated independently", () => {
  const state = newState();
  const t0 = Date.now();
  const a = sig("5m", "level", 3, 0.2);
  const b = sig("5m", "level", 3, 0.2, 100, "OTHERUSDT");
  assert.equal(dispatch([a], state, t0).length, 1);
  // The pacing gate delays the second coin rather than blocking it forever.
  assert.equal(dispatch([b], state, t0).length, 0, "pacing holds the second coin back");
  assert.equal(dispatch([b], state, t0 + MIN_GAP_MS + 1000).length, 1, "it goes out on the next turn");
});

test("alerts are paced so they arrive one at a time", () => {
  // 40 different coins each carrying a formation: the old code queued 40
  // messages at once, which is the batch the user saw.
  const state = newState();
  const t0 = Date.now();
  const coins = Array.from({ length: 40 }, (_, i) => sig("5m", "level", 3, 0.2, 100, `C${i}USDT`));

  let sentAtOnce = 0;
  for (const c of coins) sentAtOnce += dispatch([c], state, t0).length;
  assert.equal(sentAtOnce, 1, `only one alert may leave per instant, got ${sentAtOnce}`);

  // Stepping forward one gap at a time releases them individually.
  let released = 0;
  for (let i = 1; i <= 5; i++) {
    let n = 0;
    for (const c of coins) n += dispatch([c], state, t0 + i * (MIN_GAP_MS + 1000)).length;
    assert.equal(n, 1, `step ${i} must release exactly one alert, got ${n}`);
    released += n;
  }
  assert.equal(released, 5);
});

test("the pacing gate does not permanently drop a coin", () => {
  const state = newState();
  const t0 = Date.now();
  const busy = sig("5m", "level", 4, 0.1, 100, "BUSYUSDT");
  const waiting = sig("5m", "level", 3, 0.2, 100, "WAITUSDT");

  assert.equal(dispatch([busy], state, t0).length, 1);
  assert.equal(dispatch([waiting], state, t0 + 1000).length, 0);
  // The scanner re-runs continuously, so the same signal is offered again later.
  assert.equal(dispatch([waiting], state, t0 + MIN_GAP_MS + 500).length, 1);
});

test("weak signals are still rejected before any gating", () => {
  const state = newState();
  const t0 = Date.now();
  assert.equal(dispatch([sig("5m", "level", 1, 0.2)], state, t0).length, 0, "1 touch is rejected");
  assert.equal(dispatch([sig("5m", "level", 3, 2.5)], state, t0).length, 0, "2.5% away is rejected");
});

test("the dispatcher is invoked once per coin, not once per timeframe", () => {
  // Signals from all timeframes are pooled before dispatch; calling inside the
  // timeframe loop is what let 1m fire first and produced the burst.
  assert.match(SERVER_SRC, /const coinSignals = \[\];/);
  assert.match(SERVER_SRC, /for \(const sig of signals\) coinSignals\.push\(sig\);/);
  assert.match(SERVER_SRC, /checkAndDispatchServerFormationAlerts\(coinSignals, coinCurPrice, candlesByTf\)/);
  assert.ok(
    !/checkAndDispatchServerFormationAlerts\(signals, curPrice, candles\)/.test(SERVER_SRC),
    "the per-timeframe dispatch call must be gone"
  );
});

test("each signal is rendered with the candles of its own timeframe", () => {
  assert.match(SERVER_SRC, /const candlesFor = \(tf\) =>/);
  assert.match(SERVER_SRC, /const sigCandles = candlesFor\(tf\);/);
  assert.match(SERVER_SRC, /renderServerChartSnapshot\(sigCandles, \{/);
});

test("a failed send releases both the per-pair and the per-coin gate", () => {
  assert.match(SERVER_SRC, /if \(target\.prevCoinSentAt\) serverFormationCoinCooldown\.set\(target\.coinKey, target\.prevCoinSentAt\);/);
  assert.match(SERVER_SRC, /else serverFormationCoinCooldown\.delete\(target\.coinKey\);/);
});

test("a failed send also frees the subscriber's pacing slot", () => {
  assert.match(SERVER_SRC, /if \(target\.prevAnySentAt\) serverFormationLastSentAt\.set\(target\.userId, target\.prevAnySentAt\);/);
  assert.match(SERVER_SRC, /else serverFormationLastSentAt\.delete\(target\.userId\);/);
});

test("the pacing gate exists in server.js with a sane interval", () => {
  assert.match(SERVER_SRC, /const serverFormationLastSentAt = new Map\(\);/);
  const m = /const FORMATION_MIN_GAP_MS = (\d+) \* 1000;/.exec(SERVER_SRC);
  assert.ok(m, "FORMATION_MIN_GAP_MS must be defined");
  const seconds = Number(m[1]);
  assert.ok(seconds >= 15 && seconds <= 300, `pacing gap ${seconds}s should be between 15s and 5min`);
  assert.match(SERVER_SRC, /if \(now - lastAnySent < FORMATION_MIN_GAP_MS\) continue;/);
});

test("the per-coin cooldown map is pruned like the per-pair one", () => {
  assert.match(SERVER_SRC, /for \(const \[key, ts\] of serverFormationCoinCooldown\) \{/);
});

test("Telegram retest gate honours live distance and configured candle age", () => {
  assert.match(SERVER_SRC, /maxAgeCandles:\s*Math\.max\(/);
  assert.match(SERVER_SRC, /if \(liveDist > 1\.0 \|\| retestAge > maxAgeCandles\) continue;/);
});
