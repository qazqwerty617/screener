"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/arbitrage-pro.js"), "utf8");
const block = name => new RegExp(`(?:async )?function ${name}\\([^]*?\\n  \\}`).exec(source)?.[0] || "";
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const requests = [], pro = { row: { key: "spread:A" }, requestId: 1, historySeq: 0, depthSeq: 0, history: [], depth: null };
  const input = { value: 500 };
  const context = { pro, $: id => id === "arb-notional" ? input : null, renderDepth() {}, renderCharts() {},
    AbortController, setTimeout, clearTimeout,
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })) };
  vm.runInNewContext(["requestJson", "loadDepth", "loadServerHistory"].map(block).join("\n"), context);
  return { requests, pro, input, context };
}
test("changing depth notional replaces the request and ignores the old response", async () => {
  const { requests, pro, input, context } = setup();
  const first = context.loadDepth(); input.value = 1000; const second = context.loadDepth();
  // Resolve all requests even on failure so a timeout cannot outlive the test.
  const count = requests.length;
  requests.forEach((r, i) => r.resolve({ ok: true, json: async () => ({ requestedNotional: i ? 1000 : 500, complete: true }) }));
  await Promise.all([first, second]);
  assert.equal(count, 2);
  assert.equal(pro.depth.requestedNotional, 1000);
  assert.equal(requests[0].options.signal.aborted, true);
});
test("history validates route identity after the response body finishes", async () => {
  const { requests, pro, context } = setup(); let resolveBody;
  const request = context.loadServerHistory(pro.row.key);
  requests[0].resolve({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) });
  await tick(); pro.requestId++; pro.row = { key: "spread:B" };
  resolveBody({ points: [[Date.now(), 1, 10, 11, 1, 0, 10, 11]] });
  await request;
  assert.equal(pro.history.length, 0);
});
