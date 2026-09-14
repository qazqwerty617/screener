"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAuthenticatedCatalogue } = require("../authenticatedTransferCatalogs");

test("signed read-only wallet catalogues normalize Bybit and OKX networks", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("bybit")) return { ok: true, json: async () => ({ result: { rows: [{ coin: "USDT", chains: [{ chain: "TRX", chainDeposit: "1", chainWithdraw: "1" }] }] } }) };
    return { ok: true, json: async () => ({ data: [{ ccy: "USDT", chain: "USDT-TRC20", canDep: true, canWd: true }] }) };
  };
  const credentials = { apiKey: "key", apiSecret: "secret", passphrase: "pass" };
  const bybit = await fetchAuthenticatedCatalogue("BB", credentials, fetchImpl, () => 1_700_000_000_000);
  const okx = await fetchAuthenticatedCatalogue("OX", credentials, fetchImpl, () => 1_700_000_000_000);

  assert.equal(bybit.get("USDT")[0].network, "TRX");
  assert.equal(okx.get("USDT")[0].network, "TRX");
  assert.ok(requests[0].options.headers["X-BAPI-SIGN"]);
  assert.ok(requests[1].options.headers["OK-ACCESS-SIGN"]);
  assert.equal(requests[1].options.headers["OK-ACCESS-PASSPHRASE"], "pass");
});
