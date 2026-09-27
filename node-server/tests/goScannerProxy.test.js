"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const code = server.slice(server.indexOf('const GO_SCANNER_URL ='), server.indexOf('function cacheKey('));
function harness(status, data) {
  const routes = new Map();
  vm.runInNewContext(code, { app: { get: (path, fn) => routes.set(path, fn) }, setPublicCors() {},
    fetch: async () => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) }), AbortSignal });
  return routes;
}
test("scanner warming up returns 202 instead of treating an error object as candles", async () => {
  const routes = harness(202, { error: "History loading" });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await routes.get("/api/go-klines")({ query: {} }, res);
  assert.equal(res.code, 202);
  assert.match(res.body.error, /History loading/);
});
test("scanner health distinguishes warming up from ready", async () => {
  const routes = harness(202, { error: "History loading" });
  const res = { json(body) { this.body = body; } };
  await routes.get("/api/go-status")({}, res);
  assert.equal(res.body.status, "warming_up");
});
