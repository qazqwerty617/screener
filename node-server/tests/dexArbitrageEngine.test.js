"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectVerifiedContracts,
  normalizeDexPairs,
  buildDexOpportunities,
  createDexArbitrageService,
} = require("../dexArbitrageEngine");

test("DEX discovery is contract-first and never falls back to a matching symbol", () => {
  const catalogs = new Map([["BN", new Map([
    ["BREW", [
      { network: "BSC", contractAddress: "0x1111111111111111111111111111111111111111" },
      { network: "SOL", contractAddress: null },
    ]],
  ])]]);
  const contracts = collectVerifiedContracts(catalogs, ["BREW"]);
  assert.deepEqual(contracts.map(item => item.id), ["bsc:0x1111111111111111111111111111111111111111"]);

  const pairs = normalizeDexPairs(contracts[0], [{
    chainId: "bsc", dexId: "pancakeswap", pairAddress: "0xpair",
    baseToken: { address: "0x2222222222222222222222222222222222222222", symbol: "BREW" },
    quoteToken: { address: "0xusdt", symbol: "USDT" },
    priceUsd: "0.1", liquidity: { usd: 500000 }, volume: { h24: 100000 },
  }]);
  assert.deepEqual(pairs, [], "same symbol with a different contract must be rejected");
});

test("normalizes verified DEX pools and computes only plausible liquid CEX/DEX edges", () => {
  const contract = {
    id: "bsc:0x1111111111111111111111111111111111111111",
    base: "BREW", network: "BSC", chainId: "bsc",
    contractAddress: "0x1111111111111111111111111111111111111111", sources: ["BN"],
  };
  const pairs = normalizeDexPairs(contract, [{
    chainId: "bsc", dexId: "pancakeswap", pairAddress: "0xpair", url: "https://dexscreener.com/bsc/0xpair",
    baseToken: { address: contract.contractAddress, symbol: "BREW" },
    quoteToken: { address: "0xusdt", symbol: "USDT" },
    priceUsd: "1.01", liquidity: { usd: 800000 }, volume: { h24: 350000 },
    txns: { m5: { buys: 2, sells: 1 }, h1: { buys: 12, sells: 8 } },
    pairCreatedAt: Date.now() - 86400000,
  }]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].contractVerified, true);

  const rows = buildDexOpportunities([{
    base: "BREW", buyEx: "BN", buyName: "Binance", buyAsk: 0.99,
    sellEx: "BB", sellName: "Bybit", sellBid: 1.00, ageMs: 200,
  }], pairs, { minLiquidityUsd: 50000, maxAbsGrossPct: 20 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].base, "BREW");
  assert.equal(rows[0].dexName, "PancakeSwap");
  assert.equal(rows[0].contractMatch, "exact");
  assert.equal(rows[0].quality, "indicative");
  assert.ok(rows[0].netPct > 0);
});

test("rejects illiquid pools and absurd contract-safe price gaps", () => {
  const pair = {
    base: "BREW", tokenPriceUsd: 5, liquidityUsd: 1000, volume24hUsd: 10,
    transactions5m: 2, transactions1h: 10,
    dexId: "unknown", dexName: "Unknown", chainId: "bsc", network: "BSC",
    contractAddress: "0x1111111111111111111111111111111111111111", contractVerified: true,
  };
  const cex = [{ base: "BREW", buyEx: "BN", buyName: "Binance", buyAsk: 1, sellEx: "BB", sellName: "Bybit", sellBid: 1 }];
  assert.deepEqual(buildDexOpportunities(cex, [pair]), []);
});

test("does not attach one exchange's contract identity to another exchange's same ticker", () => {
  const pair = {
    base: "BREW", tokenPriceUsd: 1.01, liquidityUsd: 500000, volume24hUsd: 100000,
    transactions5m: 2, transactions1h: 10,
    dexId: "pancakeswap", dexName: "PancakeSwap", chainId: "bsc", network: "BSC",
    contractAddress: "0x1111111111111111111111111111111111111111", contractSources: ["BG"], contractVerified: true,
  };
  const onlyBinance = [{ base: "BREW", buyEx: "BN", buyName: "Binance", buyAsk: 0.99, buyBid: 0.98 }];
  assert.deepEqual(buildDexOpportunities(onlyBinance, [pair]), []);
});

test("rejects inactive pools whose displayed price can be stale", () => {
  const pair = {
    base: "BREW", tokenPriceUsd: 1.01, liquidityUsd: 500000, volume24hUsd: 100000,
    transactions5m: 0, transactions1h: 0,
    dexId: "pancakeswap", dexName: "PancakeSwap", chainId: "bsc", network: "BSC",
    contractAddress: "0x1111111111111111111111111111111111111111", contractSources: ["BN"], contractVerified: true,
  };
  const cex = [{ base: "BREW", buyEx: "BN", buyName: "Binance", buyAsk: 0.99, buyBid: 0.98 }];
  assert.deepEqual(buildDexOpportunities(cex, [pair]), []);
});

test("forced DEX refreshes are throttled to protect the upstream pool API", async () => {
  let requests = 0;
  const catalog = new Map([["BREW", [{
    network: "BSC",
    contractAddress: "0x1111111111111111111111111111111111111111",
  }]]]);
  const transferService = {
    catalogs: new Map([["BN", catalog]]),
    refresh: async () => {},
  };
  const service = createDexArbitrageService(async () => {
    requests += 1;
    return [];
  }, transferService, () => [{ base: "BREW", buyEx: "BN", buyAsk: 1 }], { ttlMs: 60_000 });

  await service.getSnapshot({ force: true });
  await service.getSnapshot({ force: true });
  assert.equal(requests, 1);
});
