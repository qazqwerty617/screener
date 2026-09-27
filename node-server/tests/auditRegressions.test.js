"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { buildDexOpportunities, createDexArbitrageService } = require("../dexArbitrageEngine");
const { createSourceReader } = require("../newsSources");
const pair = { base: "COIN", tokenPriceUsd: 1.03, liquidityUsd: 500000, volume24hUsd: 100000,
  transactions5m: 5, contractVerified: true, contractSources: ["BN"], chainId: "bsc", pairAddress: "pool", dexName: "DEX" };
test("DEX rejects stale aggregated CEX quotes just like raw quotes", () => {
  assert.equal(buildDexOpportunities([{ base: "COIN", buyEx: "BN", buyAsk: 1, ageMs: 60000 }], [pair]).length, 0);
});
test("DEX discovery rotates past the per-cycle contract budget", async () => {
  let clock = 1800000000000;
  const catalog = new Map(Array.from({ length: 7 }, (_, i) => [`C${i}`, [{ network: "BSC", contractAddress: `0x${String(i).padStart(40, "0")}` }]]));
  const seen = new Set();
  const service = createDexArbitrageService(async url => { for (const address of url.split("/").at(-1).split(",")) seen.add(address); return []; },
    { catalogs: new Map([["BN", catalog]]), refresh: async () => {} },
    () => [...catalog.keys()].map(base => ({ base, buyEx: "BN", buyAsk: 1, ageMs: 0 })),
    { contractLimit: 3, clock: () => clock });
  for (let i = 0; i < 3; i++) { await service.getSnapshot(); clock += 30001; }
  assert.equal(seen.size, 7, "every eligible contract must eventually be scanned");
});
test("simultaneous readers share a publisher request", async () => {
  let requests = 0;
  const read = createSourceReader({ request: async () => { requests++; return new Response("news"); } });
  const values = await Promise.all(Array.from({ length: 50 }, () => read("https://example.com/feed")));
  assert.equal(requests, 1);
  assert.ok(values.every(v => v === "news"));
});
