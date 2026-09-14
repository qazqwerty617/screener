"use strict";
// ═══════════════════════════════════════════════════════════════════════════════
// Venue error envelopes.
//
// Bitget, OKX, Bybit, KuCoin, BingX, HTX, MEXC and Gate all answer a rate limit
// or a bad symbol with HTTP 200 and an error code in the body. The depth parsers
// read `d.data` without checking that code, so every one of those causes arrived
// at the scanner as the same "empty book" — and `pollSymbol`'s rate-limit
// detector, which reads the error message, never saw a reason to back off.
// Measured effect: Bitget held 6-7% symbol coverage for twelve minutes straight
// (62 of 828 symbols) while its throttle never engaged.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { assertVenueOk } = require("../wallScanner.js");
const SRC = fs.readFileSync(path.join(__dirname, "..", "wallScanner.js"), "utf8");

/** The live rate-limit predicate from pollSymbol, so the test tracks the code. */
function rateLimitDetector() {
  const m = /const rateLimited = (\/.*\/i)\.test\(message\);/.exec(SRC);
  assert.ok(m, "pollSymbol must still classify errors as rate limits");
  const re = new Function(`return ${m[1]};`)();
  return (message) => re.test(String(message));
}

// Real response shapes, error and success, per venue.
const CASES = {
  BN: {
    ok: { lastUpdateId: 1, bids: [["1", "2"]], asks: [["2", "1"]] },
    err: { code: -1121, msg: "Invalid symbol." },
    throttle: { code: -1003, msg: "Too many requests; current limit is 2400 request weight per minute." },
  },
  AD: {
    ok: { bids: [["1", "2"]], asks: [["2", "1"]] },
    err: { code: -1121, msg: "Invalid symbol." },
    throttle: { code: -1003, msg: "Too many requests." },
  },
  BB: {
    ok: { retCode: 0, retMsg: "OK", result: { b: [["1", "2"]], a: [["2", "1"]] } },
    err: { retCode: 10001, retMsg: "params error: symbol invalid", result: {} },
    throttle: { retCode: 10006, retMsg: "Too many visits!", result: {} },
  },
  OX: {
    ok: { code: "0", msg: "", data: [{ bids: [["1", "2", "0", "1"]], asks: [["2", "1", "0", "1"]] }] },
    err: { code: "51001", msg: "Instrument ID does not exist", data: [] },
    throttle: { code: "50011", msg: "Requests too frequent", data: [] },
  },
  BG: {
    ok: { code: "00000", msg: "success", data: { bids: [["1", "2"]], asks: [["2", "1"]] } },
    err: { code: "40034", msg: "Parameter symbol does not exist", data: null },
    throttle: { code: "429", msg: "Too many requests, please try again later", data: null },
  },
  KC: {
    ok: { code: "200000", data: { bids: [["1", "2"]], asks: [["2", "1"]] } },
    err: { code: "400100", msg: "Invalid symbol" },
    throttle: { code: "429000", msg: "Too Many Requests" },
  },
  BX: {
    ok: { code: 0, msg: "", data: { bids: [["1", "2"]], asks: [["2", "1"]] } },
    err: { code: 100400, msg: "symbol not exist" },
    throttle: { code: 100410, msg: "rate limit exceeded" },
  },
  HT: {
    ok: { status: "ok", tick: { bids: [[1, 2]], asks: [[2, 1]] } },
    err: { status: "error", "err-code": "invalid-parameter", "err-msg": "invalid symbol" },
    throttle: { status: "error", "err-code": "429", "err-msg": "too many requests" },
  },
  MX: {
    ok: { success: true, code: 0, data: { bids: [[1, 2]], asks: [[2, 1]] } },
    err: { success: false, code: 400, message: "symbol not exists" },
    throttle: { success: false, code: 510, message: "request frequency too fast" },
  },
  GT: {
    ok: { id: 1, bids: [{ p: "1", s: 2 }], asks: [{ p: "2", s: 1 }] },
    err: { label: "CONTRACT_NOT_FOUND", message: "contract not found" },
    throttle: { label: "TOO_MANY_REQUESTS", message: "Too many requests" },
  },
  HL: {
    ok: { coin: "BTC", levels: [[{ px: "1", sz: "2" }], [{ px: "2", sz: "1" }]], time: 1 },
    err: { error: "unknown coin" },
    throttle: { error: "Too many requests" },
  },
};

test("every venue's success payload passes untouched", () => {
  for (const [ex, c] of Object.entries(CASES)) {
    assert.doesNotThrow(() => assertVenueOk(ex, c.ok), `${ex} rejected its own success body`);
  }
});

test("every venue's error payload throws with its own code and message", () => {
  for (const [ex, c] of Object.entries(CASES)) {
    assert.throws(() => assertVenueOk(ex, c.err), err => {
      const msg = String(err.message);
      assert.notEqual(msg, "empty book", `${ex} error must not masquerade as an empty book`);
      assert.ok(msg.length > 3, `${ex} threw an empty message`);
      return true;
    }, `${ex} swallowed an error payload`);
  }
});

test("a throttle payload reaches pollSymbol as a recognisable rate limit", () => {
  // This is the link that was missing: without it the scanner treats a 429 as a
  // plain failure, keeps its tokens, and hammers the venue at full rate.
  const isRateLimit = rateLimitDetector();
  for (const [ex, c] of Object.entries(CASES)) {
    let message = null;
    try { assertVenueOk(ex, c.throttle); } catch (e) { message = e.message; }
    assert.ok(message, `${ex} did not reject its throttle payload`);
    assert.ok(isRateLimit(message), `${ex} throttle not detected as a rate limit: ${message}`);
  }
});

test("the detector does not fire on innocent wording", () => {
  const isRateLimit = rateLimitDetector();
  for (const benign of ["empty book", "could not generate book", "separate feed offline",
    "aborted", "socket hang up", "unsupported exchange ZZ"]) {
    assert.equal(isRateLimit(benign), false, `false positive on "${benign}"`);
  }
});

test("a missing or non-object payload is named, not dereferenced", () => {
  for (const bad of [null, undefined, "", "<html>502</html>", 0]) {
    assert.throws(() => assertVenueOk("BG", bad), /empty response/,
      `payload ${JSON.stringify(bad)} must produce a clear error`);
  }
});

test("a zero code is success, not an error", () => {
  // BingX and Bybit signal success with a numeric 0; a truthiness check here
  // would reject every good response.
  assert.doesNotThrow(() => assertVenueOk("BX", { code: 0, data: { bids: [], asks: [] } }));
  assert.doesNotThrow(() => assertVenueOk("BB", { retCode: 0, result: { b: [], a: [] } }));
  assert.doesNotThrow(() => assertVenueOk("OX", { code: "0", data: [] }));
  assert.doesNotThrow(() => assertVenueOk("BG", { code: "00000", data: {} }));
});

test("a one-sided book is still a valid book", () => {
  // Thin instruments legitimately have an empty side; only the venue's own code
  // decides whether the response is an error.
  assert.doesNotThrow(() => assertVenueOk("GT", { id: 1, bids: [], asks: [{ p: "2", s: 1 }] }));
  assert.doesNotThrow(() => assertVenueOk("HL", { coin: "X", levels: [[], [{ px: "1", sz: "1" }]] }));
});

test("every branch of fetchOB validates its response", () => {
  const m = /async function fetchOB\(ex, coin, apiFetch, deep, timeoutMs\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(m, "fetchOB must exist");
  const body = m[0];
  const fetches = (body.match(/await apiFetch\(/g) || []).length;
  const checks = (body.match(/assertVenueOk\(ex, d\);/g) || []).length;
  assert.equal(checks, fetches,
    `${fetches} venue requests but ${checks} validations — a venue was added without one`);
  assert.ok(fetches >= 11, `expected one request per venue, found ${fetches}`);
});

test("the empty-book error is still reachable for a genuinely flat book", () => {
  // It has to stay: a venue can answer 200/OK with both sides empty, and that
  // symbol must not be ingested as if it had liquidity.
  assert.match(SRC, /if \(!bids\.length && !asks\.length\) throw new Error\("empty book"\);/);
});
