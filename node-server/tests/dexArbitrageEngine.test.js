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

test("DEX estimates include both reserve-side price impact and reject stale one-hour activity", () => {
  const pair = {
    base: "BREW", tokenPriceUsd: 1.02, liquidityUsd: 100_000, volume24hUsd: 100_000,
    transactions5m: 1, transactions1h: 10,
    dexId: "pancakeswap", dexName: "PancakeSwap", chainId: "bsc", network: "BSC",
    pairAddress: "0xpair", contractAddress: "0x1111111111111111111111111111111111111111",
    contractSources: ["BN"], contractVerified: true,
  };
  const cex = [{ base: "BREW", buyEx: "BN", buyName: "Binance", buyAsk: 1, buyBid: 0.99, ageMs: 100 }];
  const rows = buildDexOpportunities(cex, [pair], { notionalUsd: 1_000, dexFeePct: 0, cexFeePct: 0 });
  assert.equal(rows.length, 0, "a 2% spot gap cannot survive roughly 2% reserve impact");
  pair.transactions5m = 0;
  pair.tokenPriceUsd = 1.1;
  assert.equal(buildDexOpportunities(cex, [pair], { notionalUsd: 100, dexFeePct: 0, cexFeePct: 0 }).length, 0);
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

test("DEX opportunities use the live ticker universe even without a CEX-to-CEX spread", () => {
  const now = Date.now();
  const tickers = new Map([["BN|BREWUSDT", {
    base: "BREW", sym: "BREWUSDT", ex: "BN", p: 0.99, bid: 0.985, ask: 0.99,
    v: 2_000_000, quoteTs: now,
  }]]);
  const pair = {
    base: "BREW", tokenPriceUsd: 1.01, liquidityUsd: 500_000, volume24hUsd: 100_000,
    transactions5m: 2, transactions1h: 10,
    dexId: "pancakeswap", dexName: "PancakeSwap", chainId: "bsc", network: "BSC",
    pairAddress: "0xpair", pairUrl: "https://dexscreener.com/bsc/0xpair",
    contractAddress: "0x1111111111111111111111111111111111111111",
    contractSources: ["BN"], contractVerified: true,
  };

  const rows = buildDexOpportunities(tickers, [pair], { now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cexEx, "BN");
  assert.match(rows[0].cexUrl, /binance/i);
});

test("a recent last trade does not make an old CEX order book executable", () => {
  const now = Date.now();
  const pair = {
    base: "BREW", tokenPriceUsd: 1.02, liquidityUsd: 500_000, volume24hUsd: 100_000,
    transactions5m: 1, transactions1h: 10, dexId: "pancakeswap", dexName: "PancakeSwap",
    chainId: "bsc", network: "BSC", pairAddress: "0xpair",
    contractAddress: "0x1111111111111111111111111111111111111111",
    contractSources: ["BN"], contractVerified: true,
  };
  const tickers = new Map([["BN|BREWUSDT", {
    base: "BREW", sym: "BREWUSDT", ex: "BN", p: 0.99, bid: 0.985, ask: 0.99,
    v: 2_000_000, quoteTs: now, bboTs: now - 20_000,
  }]]);
  assert.equal(buildDexOpportunities(tickers, [pair], { now }).length, 0);
});

test("DEX service retains bounded route history for the detail chart", async () => {
  let now = 1_800_000_000_000;
  let dexPrice = 1.01;
  const contractAddress = "0x1111111111111111111111111111111111111111";
  const transferService = {
    catalogs: new Map([["BN", new Map([["BREW", [{ network: "BSC", contractAddress }]]])]]),
    refresh: async () => {},
  };
  const tickers = new Map([["BN|BREWUSDT", {
    base: "BREW", sym: "BREWUSDT", ex: "BN", p: 0.99, bid: 0.985, ask: 0.99,
    v: 2_000_000, quoteTs: now,
  }]]);
  const service = createDexArbitrageService(async () => [{
    chainId: "bsc", dexId: "pancakeswap", pairAddress: "0xpair",
    url: "https://dexscreener.com/bsc/0xpair",
    baseToken: { address: contractAddress, symbol: "BREW" },
    quoteToken: { address: "0xusdt", symbol: "USDT" },
    priceUsd: String(dexPrice), liquidity: { usd: 500_000 }, volume: { h24: 100_000 },
    txns: { m5: { buys: 2, sells: 1 }, h1: { buys: 12, sells: 8 } },
  }], transferService, () => tickers, {
    ttlMs: 30_000, forceMinAgeMs: 0, clock: () => now, historyLimit: 2,
  });

  const first = await service.getSnapshot({ force: true });
  now += 1_000;
  tickers.get("BN|BREWUSDT").quoteTs = now;
  dexPrice = 1.02;
  await service.getSnapshot({ force: true });
  now += 1_000;
  tickers.get("BN|BREWUSDT").quoteTs = now;
  dexPrice = 1.03;
  await service.getSnapshot({ force: true });

  const history = service.getHistory(first.rows[0].key);
  assert.equal(history.points.length, 2);
  assert.deepEqual(history.points.map(point => point[0]), [1_800_000_001_000, 1_800_000_002_000]);
});

test("DEX pool cache never keeps an obsolete CEX edge alive", async () => {
  let now = 1_800_000_000_000;
  let requests = 0;
  const contractAddress = "0x1111111111111111111111111111111111111111";
  const transferService = {
    catalogs: new Map([["BN", new Map([["BREW", [{ network: "BSC", contractAddress }]]])]]),
    refresh: async () => {},
  };
  const ticker = { base: "BREW", sym: "BREWUSDT", ex: "BN", p: 0.99, bid: 0.985, ask: 0.99, v: 2_000_000, quoteTs: now };
  const service = createDexArbitrageService(async () => {
    requests += 1;
    return [{
      chainId: "bsc", dexId: "pancakeswap", pairAddress: "0xpair",
      baseToken: { address: contractAddress, symbol: "BREW" }, quoteToken: { address: "0xusdt", symbol: "USDT" },
      priceUsd: "1.02", liquidity: { usd: 500_000 }, volume: { h24: 100_000 },
      txns: { m5: { buys: 2, sells: 1 }, h1: { buys: 12, sells: 8 } },
    }];
  }, transferService, () => new Map([["BN|BREWUSDT", ticker]]), { clock: () => now, ttlMs: 60_000 });
  assert.equal((await service.getSnapshot()).rows.length, 1);
  assert.equal((await service.getSnapshot({ minVolume24hUsd: 200_000 })).rows.length, 0, "24h volume filter must use traded volume, not pool liquidity");
  now += 20_000;
  assert.equal((await service.getSnapshot()).rows.length, 0, "a CEX quote older than 15s must disappear while DEX data stays cached");
  ticker.quoteTs = now;
  ticker.ask = 1.05;
  ticker.bid = 1.00;
  assert.equal((await service.getSnapshot()).rows.length, 0, "a repriced CEX quote must be used immediately");
  assert.equal(requests, 1, "pool API should remain cached");
});
