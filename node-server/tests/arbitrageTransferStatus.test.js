"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBinance,
  normalizeBybit,
  normalizeOkx,
  normalizeMexc,
  normalizeBitget,
  normalizeGate,
  normalizeKucoin,
  normalizeHtx,
  resolveTransferRoute,
  createTransferStatusService,
  PUBLIC_SOURCES,
} = require("../arbitrageTransferStatus");

test("normalizes major venue catalogues that otherwise leave transfer routes unknown", () => {
  const binance = normalizeBinance({ data: [{
    coin: "USDT",
    networkList: [{ network: "TRX", depositEnable: true, withdrawEnable: true, withdrawFee: "1" }],
  }] });
  const bybit = normalizeBybit({ result: { rows: [{
    coin: "USDT",
    chains: [{ chain: "TRX", chainType: "TRC20", chainDeposit: "1", chainWithdraw: "1", withdrawalFee: "1" }],
  }] } });
  const okx = normalizeOkx({ data: [{
    ccy: "USDT", chain: "USDT-TRC20", canDep: true, canWd: true, fee: "1", minWd: "2",
  }] });
  const mexc = normalizeMexc([{ coin: "USDT", networkList: [{
    network: "TRX", name: "TRC20", depositEnable: true, withdrawEnable: true, withdrawFee: "1",
  }] }]);

  for (const catalog of [binance, bybit, okx, mexc]) {
    assert.equal(catalog.get("USDT")[0].network, "TRX");
    assert.equal(catalog.get("USDT")[0].deposit, true);
    assert.equal(catalog.get("USDT")[0].withdraw, true);
  }

  const catalogs = new Map([["BN", binance], ["BB", bybit], ["OX", okx], ["MX", mexc]]);
  for (const [buyEx, sellEx] of [["BN", "BB"], ["BN", "OX"], ["MX", "BN"]]) {
    const route = resolveTransferRoute(catalogs, "USDT", buyEx, sellEx);
    assert.equal(route.status, "open");
    assert.deepEqual(route.networks, ["TRX"]);
  }
});

test("normalizes public deposit and withdrawal catalogues", () => {
  const bitget = normalizeBitget({ data: [{ coin: "BTC", chains: [{ chain: "BTC", rechargeable: "true", withdrawable: "true" }] }] });
  const gate = normalizeGate([{ currency: "BTC", chains: [{ name: "BTC", deposit_disabled: false, withdraw_disabled: false }] }]);
  const kucoin = normalizeKucoin({ data: [{ currency: "BTC", chains: [{ chainName: "BTC", isDepositEnabled: true, isWithdrawEnabled: true }] }] });
  const htx = normalizeHtx({ data: [{ currency: "btc", chains: [{ chain: "btc", depositStatus: "allowed", withdrawStatus: "allowed" }] }] });

  for (const catalog of [bitget, gate, kucoin, htx]) {
    assert.equal(catalog.get("BTC")[0].deposit, true);
    assert.equal(catalog.get("BTC")[0].withdraw, true);
  }
});

test("resolves only a genuinely open shared transfer network", () => {
  const catalogs = new Map([
    ["BG", new Map([["USDT", [{ network: "TRC20", deposit: true, withdraw: true }]]])],
    ["KC", new Map([["USDT", [
      { network: "TRON", deposit: true, withdraw: true },
      { network: "ERC20", deposit: true, withdraw: false },
    ]]])],
  ]);

  const route = resolveTransferRoute(catalogs, "USDT", "BG", "KC");
  assert.equal(route.status, "open");
  assert.deepEqual(route.networks, ["TRX"]);
  assert.equal(route.buy.withdraw, true);
  assert.equal(route.sell.deposit, true);
});

test("does not call a route open when both exchanges expose different contracts on the same chain", () => {
  const catalogs = new Map([
    ["BN", new Map([["BREW", [{ network: "BSC", deposit: true, withdraw: true, contractAddress: "0x111" }]]])],
    ["BG", new Map([["BREW", [{ network: "BSC", deposit: true, withdraw: true, contractAddress: "0x222" }]]])],
  ]);
  assert.equal(resolveTransferRoute(catalogs, "BREW", "BN", "BG").status, "closed");
});

test("returns unknown instead of inventing availability for private APIs", () => {
  const route = resolveTransferRoute(new Map(), "BTC", "BN", "BB");
  assert.equal(route.status, "unknown");
  assert.equal(route.buy.withdraw, null);
  assert.equal(route.sell.deposit, null);
});

test("a failed venue retries independently instead of freezing a partial catalogue for the full TTL", async () => {
  let now = 100_000;
  let gateCalls = 0;
  const fixtures = new Map([
    [PUBLIC_SOURCES.BN, { data: [{ coin: "BTC", networkList: [{ network: "BTC", depositEnable: true, withdrawEnable: true }] }] }],
    [PUBLIC_SOURCES.BG, { data: [{ coin: "BTC", chains: [{ chain: "BTC", rechargeable: true, withdrawable: true }] }] }],
    [PUBLIC_SOURCES.KC, { data: [{ currency: "BTC", chains: [{ chainName: "BTC", isDepositEnabled: true, isWithdrawEnabled: true }] }] }],
    [PUBLIC_SOURCES.HT, { data: [{ currency: "BTC", chains: [{ chain: "BTC", depositStatus: "allowed", withdrawStatus: "allowed" }] }] }],
  ]);
  const service = createTransferStatusService(async url => {
    if (url === PUBLIC_SOURCES.GT) {
      gateCalls++;
      if (gateCalls === 1) throw new Error("temporary gate outage");
      return [{ currency: "BTC", chains: [{ name: "BTC", deposit_disabled: false, withdraw_disabled: false }] }];
    }
    return fixtures.get(url);
  }, { ttlMs: 60_000, retryMs: 5_000, now: () => now });

  await service.refresh(true);
  assert.equal(service.catalogs.has("GT"), false);
  now += 6_000;
  await service.refresh(false);
  assert.equal(gateCalls, 2);
  assert.equal(service.catalogs.has("GT"), true);
});
