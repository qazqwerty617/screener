"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { normalizeCoinMarketCap, loadCoinMarketCap } = require("../coinMarketCapUnlocks");
const { createPublicUnlocks } = require("../publicUnlocks");
const now = Date.UTC(2026, 8, 28), DAY = 86400000;
const coin = { cryptoId: 1, slug: "project", symbol: "P", name: "Project", isActive: 1, maxSupply: 10000, circulatingSupply: 5000,
  nextUnlocked: { date: now + DAY, tokenAmount: 300, tokenAmountPercentage: 99 },
  nextUnlockedDetail: [{ allocationName: "Team", tokenAmount: 200, vestingType: "cliff" }, { allocationName: "Rewards", tokenAmount: 100, vestingType: "linear" }] };
const page = (rows = [coin], total = rows.length, timestamp = now) => JSON.stringify({ status: { error_code: "0", timestamp: new Date(timestamp).toISOString() }, data: { tokenUnlockList: rows, totalCount: String(total) } });

test("CMC keeps types separate, computes supply shares and does not add headline to allocations", () => {
  const rows = normalizeCoinMarketCap([coin, coin, { ...coin, cryptoId: 2 }], now);
  assert.equal(rows.length, 4); assert.equal(rows[0].amount, 200); assert.equal(rows[1].amount, 100);
  assert.equal(rows[0].percentSupply, 2); assert.equal(rows[0].percentCirculating, 4);
  assert.equal(rows[0].unlockType, "cliff"); assert.equal(rows[1].unlockType, "linear");
  assert.notEqual(rows[0].assetId, rows[2].assetId, "same ticker is not same asset");
});
test("CMC rejects unsafe identities, invalid amounts/dates and leaves missing schedules empty", () => {
  const bad = [null, {}, { ...coin, slug: "../redirect" }, { ...coin, cryptoId: true },
    ...[true, -1, NaN, Infinity, ""].map(tokenAmount => ({ ...coin, nextUnlocked: { ...coin.nextUnlocked, tokenAmount } })),
    { ...coin, nextUnlocked: {} }, { ...coin, nextUnlocked: { date: now + 366 * DAY, tokenAmount: 1 } }];
  assert.deepEqual(normalizeCoinMarketCap(bad, now), []);
});
test("mismatching or malformed allocations cannot fabricate a known cliff amount", () => {
  const [row] = normalizeCoinMarketCap([{ ...coin, isActive: 0, nextUnlocked: { ...coin.nextUnlocked, tokenAmount: 500 } }], now);
  assert.equal(row.amount, 500); assert.equal(row.allocationMismatch, true); assert.equal(row.unlockType, "unknown");
  assert.equal(row.marketStatus, "inactive"); assert.deepEqual(row.allocations, []);
  assert.equal(normalizeCoinMarketCap([{ ...coin, nextUnlockedDetail: [null] }], now)[0].unlockType, "unknown");
});
test("complete CMC traversal uses page numbers, includes small unlocks and survives short intermediate pages", async () => {
  const requests = [];
  const result = await loadCoinMarketCap(async url => {
    const u = new URL(url); requests.push(u.searchParams.get("start"));
    assert.equal(u.searchParams.get("enableSmallUnlocks"), "true");
    const p = Number(u.searchParams.get("start"));
    return page(Array.from({ length: p === 3 ? 1 : p === 2 ? 99 : 100 }, (_, i) => ({ ...coin, cryptoId: (p - 1) * 100 + i + 1 })), 201);
  }, () => now);
  assert.deepEqual(requests, ["1", "2", "3"]); assert.equal(result.scannedTokens, 200);
  assert.equal(result.availableTokens, 201); assert.equal(result.partial, true);
  assert.equal(result.rows.length, 400);
});
test("repeated pages, changing totals, stale responses and source errors cannot report complete coverage", async () => {
  await assert.rejects(loadCoinMarketCap(async () => page([coin], 101), () => now), /repeated/);
  let n = 0;
  await assert.rejects(loadCoinMarketCap(async () => page([coin], ++n === 1 ? 101 : 100), () => now), /changed/);
  await assert.rejects(loadCoinMarketCap(async () => page([coin], 1, now - DAY), () => now), /Stale/);
  await assert.rejects(loadCoinMarketCap(async () => page([coin], 1, now + DAY), () => now), /Stale/);
  await assert.rejects(loadCoinMarketCap(async () => '{"status":{"error_code":"500"}}', () => now), /Invalid/);
});
test("CMC refresh is shared, a failed page retains last complete snapshot and expires after 24h", async () => {
  let time = now, fail = false, calls = 0;
  const service = createPublicUnlocks({ now: () => time, request: async url => {
    if (!url.includes("coinmarketcap")) return new Response("unavailable", { status: 503 });
    calls++;
    if (fail && new URL(url).searchParams.get("start") === "2") return new Response("rate limit", { status: 429 });
    return new Response(page([{ ...coin, cryptoId: fail ? 7 : 1 }], fail ? 101 : 1, time));
  } });
  await Promise.all(Array.from({ length: 10 }, () => service.refresh())); assert.equal(calls, 1);
  assert.equal(service.snapshot().sources.coinmarketcap.tokens, 1);
  fail = true; time += 3600001; await service.refresh();
  assert.equal(service.snapshot().sources.coinmarketcap.status, "error");
  assert.equal(service.snapshot().sources.coinmarketcap.error, "HTTP 429");
  assert.ok(service.snapshot().rows.every(row => row.assetId === "cmc:1" && row.stale));
  time += DAY; assert.deepEqual(service.snapshot().rows, []);
  fail = false; await service.refresh(); assert.equal(service.snapshot().sources.coinmarketcap.status, "ok");
});
