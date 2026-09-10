"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EXCHANGE_CODES,
  normalizeExchanges,
  isExchangeAllowed,
  toggleExchangeSelection,
  analyzeMove,
  SignalConfirmationGate,
  SignalCooldownGate
} = require("../public/js/pumpLogic");

test("clicking Binance from the initial ALL state selects Binance only", () => {
  const initial = ["all", ...EXCHANGE_CODES];
  assert.deepEqual(toggleExchangeSelection(initial, "BN"), ["BN"]);
  assert.deepEqual(toggleExchangeSelection(["BN"], "BB"), ["BN", "BB"]);
});

test("exchange selections are canonical and fail closed", () => {
  assert.deepEqual(normalizeExchanges(["binance", "Bybit", "BN", "garbage"]), ["BN", "BB"]);
  assert.equal(isExchangeAllowed("BN", ["BN", "BB"]), true);
  assert.equal(isExchangeAllowed("MX", ["BN", "BB"]), false);
  assert.equal(isExchangeAllowed("MX", []), false);
  assert.equal(isExchangeAllowed("MX", ["all"]), true);
});

test("a clean liquid impulse is accepted with a high quality score", () => {
  const now = 1_000_000;
  const result = analyzeMove([
    { t: now - 60_000, p: 100 },
    { t: now - 45_000, p: 100.2 },
    { t: now - 30_000, p: 101.1 },
    { t: now - 15_000, p: 102.2 },
    { t: now, p: 103.2 }
  ], { now, periodMs: 60_000, minPct: 2, volume: 8_000_000 });

  assert.equal(result.accepted, true);
  assert.equal(result.direction, "pump");
  assert.ok(result.quality >= 0.7);
});

test("a noisy round-trip that merely ends above threshold is rejected", () => {
  const now = 1_000_000;
  const result = analyzeMove([
    { t: now - 60_000, p: 100 },
    { t: now - 45_000, p: 104 },
    { t: now - 30_000, p: 98 },
    { t: now - 15_000, p: 104 },
    { t: now, p: 103 }
  ], { now, periodMs: 60_000, minPct: 2, volume: 8_000_000 });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "noisy_path");
});

test("an isolated bad reference tick cannot create a persistent fake pump", () => {
  const now = 1_000_000;
  const result = analyzeMove([
    { t: now - 75_000, p: 100.0 },
    { t: now - 60_000, p: 90.0 },
    { t: now - 55_000, p: 100.0 },
    { t: now, p: 100.0 }
  ], { now, periodMs: 60_000, minPct: 2, volume: 8_000_000 });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unstable_reference");
});

test("two sparse endpoint samples are not enough to prove a pump", () => {
  const now = 1_000_000;
  const result = analyzeMove([
    { t: now - 60_000, p: 100 },
    { t: now, p: 104 }
  ], { now, periodMs: 60_000, minPct: 2, volume: 8_000_000 });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "insufficient_samples");
});

test("thin markets need a stronger move than liquid markets", () => {
  const now = 1_000_000;
  const samples = [
    { t: now - 60_000, p: 100 },
    { t: now - 30_000, p: 101.2 },
    { t: now, p: 103 }
  ];
  assert.equal(analyzeMove(samples, { now, periodMs: 60_000, minPct: 2, volume: 60_000 }).accepted, false);
  assert.equal(analyzeMove(samples, { now, periodMs: 60_000, minPct: 2, volume: 8_000_000 }).accepted, true);
});

test("confirmation gate rejects a one-tick glitch and confirms a persistent impulse quickly", () => {
  const gate = new SignalConfirmationGate({ minConfirmations: 2, minSpacingMs: 250, ttlMs: 10_000 });
  assert.equal(gate.observe("BN:TESTUSDT", "pump", 1_000, 3.1), false);
  assert.equal(gate.observe("BN:TESTUSDT", "pump", 1_100, 3.2), false);
  assert.equal(gate.observe("BN:TESTUSDT", "pump", 1_300, 3.0), true);
  assert.equal(gate.observe("BN:OTHERUSDT", "pump", 20_000, 3.0), false);
});

test("cooldown gate blocks rapid opposite-direction whipsaw alerts", () => {
  const gate = new SignalCooldownGate({
    sameDirectionMs: 300_000,
    oppositeDirectionMs: 180_000,
    symbolMs: 60_000
  });

  assert.equal(gate.allow("BN:JCTUSDT", "pump", 1_000), true);
  assert.equal(gate.allow("BN:JCTUSDT", "dump", 31_000), false);
  assert.equal(gate.allow("BN:JCTUSDT", "dump", 181_001), true);
});
