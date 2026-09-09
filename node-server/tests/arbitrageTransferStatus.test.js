"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBitget,
  normalizeGate,
  normalizeKucoin,
  normalizeHtx,
  resolveTransferRoute,
} = require("../arbitrageTransferStatus");

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

test("returns unknown instead of inventing availability for private APIs", () => {
  const route = resolveTransferRoute(new Map(), "BTC", "BN", "BB");
  assert.equal(route.status, "unknown");
  assert.equal(route.buy.withdraw, null);
  assert.equal(route.sell.deposit, null);
});
