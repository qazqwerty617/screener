"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createHyperliquid = require("../exchanges/hyperliquid");

test("Hyperliquid subscribes to bounded BBO streams and uses real bid and ask", async () => {
  const tickers = new Map(), dirty = new Set(), sent = [];
  let onMessage, onOpen;
  const apiFetch = async (_url, _timeout, _retry, _method, body) => {
    if (body.type === "meta") return { universe: [{ name: "BREW" }] };
    if (body.type === "allMids") return { BREW: "1" };
    return [{ universe: [{ name: "BREW" }] }, [{ prevDayPx: "1", dayNtlVlm: "500000", funding: "0.0001", openInterest: "10000" }]];
  };
  await createHyperliquid(tickers, dirty, (_name, _url, message, open) => {
    onMessage = message; onOpen = open;
  }, apiFetch).init();
  onOpen({ send: value => sent.push(JSON.parse(value)) });
  assert.ok(sent.some(item => item.subscription.type === "bbo" && item.subscription.coin === "BREW"));
  assert.equal(tickers.get("HL:BREW").bboTs, undefined);
  onMessage(Buffer.from(JSON.stringify({ channel: "bbo", data: {
    coin: "BREW", bbo: [{ px: "0.99", sz: "100" }, { px: "1.01", sz: "100" }],
  } })));
  assert.equal(tickers.get("HL:BREW").bid, 0.99);
  assert.equal(tickers.get("HL:BREW").ask, 1.01);
  assert.ok(Date.now() - tickers.get("HL:BREW").bboTs < 1000);
});
