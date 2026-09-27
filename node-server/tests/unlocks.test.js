"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { primaryUnlocks } = require("../unlockSchedules");
const { normalizeEmissions, createUnlockService } = require("../unlockService");
const now = Date.UTC(2026, 8, 26);
test("XPL cliff and monthly ecosystem vesting are calculated separately from official schedules", () => {
  const rows = primaryUnlocks(now).filter(row => row.symbol === "XPL");
  const cliff = rows.find(row => row.at === Date.UTC(2026, 8, 25));
  assert.ok(Math.abs(cliff.amount - (5e9 / 3 + 3.2e9 / 36)) < 0.001);
  assert.equal(cliff.precision, "day");
  const next = rows.find(row => row.at === Date.UTC(2026, 9, 25));
  assert.ok(Math.abs(next.amount - (5e9 * 2 / 3 / 24 + 3.2e9 / 36)) < 0.001);
  assert.equal(next.sources.length, 2);
});
test("APT insider vesting ends at four years, community vesting continues", () => {
  const rows = primaryUnlocks(now).filter(row => row.symbol === "APT");
  assert.equal(rows.find(row => row.at === Date.UTC(2026, 9, 12)).allocations.length, 2);
  assert.equal(rows.find(row => row.at === Date.UTC(2026, 10, 12)).allocations.length, 1);
});
test("ARB monthly vesting never extends beyond its final anniversary", () => {
  const rows = primaryUnlocks(now).filter(row => row.symbol === "ARB");
  assert.ok(rows.every(row => row.at <= Date.UTC(2027, 2, 16)));
  assert.ok(Math.abs(rows[0].amount - 92645833.33333333) < 0.01);
});
const token = { gecko_id: "plasma", name: "Plasma", maxSupply: 10e9, circSupply: 2e9,
  sources: ["javascript:alert(1)", "https://plasma.org"], events: [
    { timestamp: now / 1000 + 86400, unlockType: "cliff", noOfTokens: [100, 200] },
    { timestamp: now / 1000 + 86400, unlockType: "linear", noOfTokens: [500000] },
    { timestamp: "bad", unlockType: "cliff", noOfTokens: [100] },
  ] };
test("aggregator parsing does not turn a linear emission into a cliff or invent a ticker", () => {
  const rows = normalizeEmissions([token, { ...token, gecko_id: "unmapped", name: "New project" }], now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, 300);
  assert.equal(rows[0].symbol, "XPL");
  assert.equal(rows[1].symbol, null);
  assert.deepEqual(rows[0].sources, ["https://plasma.org/"]);
});
test("unlock service shares requests, backs off on failure and marks stale cached results", async () => {
  let clock = now, calls = 0, fail = false;
  const service = createUnlockService({ apiKey: "test-key", now: () => clock, request: async () => {
    calls++; return new Response(fail ? "offline" : JSON.stringify([token]), { status: fail ? 503 : 200 });
  } });
  await Promise.all(Array.from({ length: 30 }, () => service.refresh()));
  assert.equal(calls, 1);
  assert.equal(service.snapshot().sources.defillama.status, "ok");
  fail = true; clock += 3600001; await service.refresh(); await service.refresh();
  assert.equal(calls, 2);
  assert.equal(service.snapshot().sources.defillama.stale, true);
  assert.ok(service.snapshot().rows.some(row => row.provider === "DefiLlama"));
  clock += 86400000;
  assert.ok(service.snapshot().rows.every(row => row.provider !== "DefiLlama"));
});
test("public schedules work without an API key and disclose limited coverage", async () => {
  const service = createUnlockService({ apiKey: "", now: () => now, request: () => { throw new Error("must not request paid data"); } });
  await service.refresh();
  assert.equal(service.snapshot().coverage, "primary_only");
  assert.equal(service.snapshot().sources.primary.tokens, 3);
  assert.ok(service.snapshot().rows.length > 20);
});
