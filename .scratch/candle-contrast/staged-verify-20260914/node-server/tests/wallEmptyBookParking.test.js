"use strict";
// ═══════════════════════════════════════════════════════════════════════════════
// Parking instruments that have no order book.
//
// Bitget lists ~760 tokenized-equity spot pairs (RNVDA, RLITE, RUTHR, RCSIQ …)
// that report large 24h "volume" and answer every depth request with code 00000
// and zero levels. The scanner re-asked all of them on every cycle: its entire
// venue budget went to dead instruments, and reported coverage sat at 7% —
// 70 of 829 symbols — for as long as the process ran. A curated equity list
// cannot keep up with that catalogue, so behaviour disqualifies the symbol.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "wallScanner.js"), "utf8");

/** The real buildExchangeStatuses, over injected scanner state. */
function buildStatusHarness() {
  const fn = /function buildExchangeStatuses\(now\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(fn, "buildExchangeStatuses must exist");
  return new Function("EXCHANGES", "exchangeState", "symbolStates", "SYMBOL_STALE_MS", "EXCHANGE_STALE_MS", `
    ${fn[0]}
    return buildExchangeStatuses;
  `);
}

function venue({ total, fresh, parked, now }) {
  const EXCHANGES = ["BG"];
  const exchangeState = new Map([["BG", {
    ex: "BG", status: "ok", updatedAt: now, durationMs: 10, symbolsTotal: total,
    coverageCycles: 0, lastFullCoverageAt: 0, lastLatencyMs: 30, error: null, cooldownUntil: 0,
  }]]);
  const map = new Map();
  for (let i = 0; i < total; i++) {
    map.set(`S${i}USDT`, {
      walls: [],
      updatedAt: i < fresh ? now : 0,
      parkedUntil: i >= total - parked ? now + 3600000 : 0,
    });
  }
  const build = buildStatusHarness()(EXCHANGES, exchangeState, new Map([["BG", map]]), 15 * 60 * 1000, 5 * 60 * 1000);
  return build(now).statuses.BG;
}

test("coverage is measured against the symbols that can actually be read", () => {
  const now = Date.now();
  // Bitget's real shape: 829 listed, 759 with no book, 70 readable and read.
  const parked = venue({ total: 829, fresh: 70, parked: 759, now });
  assert.equal(parked.symbolsTotal, 829, "the listed universe is still reported");
  assert.equal(parked.symbolsParked, 759);
  assert.equal(parked.symbolsScanned, 70);
  assert.equal(parked.coveragePct, 100, "70 of the 70 readable symbols is full coverage");
});

test("without parking the same venue reports a shortfall it cannot close", () => {
  const now = Date.now();
  const before = venue({ total: 829, fresh: 70, parked: 0, now });
  assert.equal(before.coveragePct, 8, "this is the 7-8% that stood in the status badge for twelve minutes");
});

test("a genuine shortfall is still reported as one", () => {
  const now = Date.now();
  const half = venue({ total: 600, fresh: 300, parked: 0, now });
  assert.equal(half.coveragePct, 50, "parking must not paper over an under-polled venue");
  const mixed = venue({ total: 600, fresh: 200, parked: 200, now });
  assert.equal(mixed.coveragePct, 50, "200 fresh of 400 readable");
});

test("an all-parked venue reports zero, not a division by zero", () => {
  const now = Date.now();
  const dead = venue({ total: 40, fresh: 0, parked: 40, now });
  assert.equal(dead.coveragePct, 0);
  assert.ok(Number.isFinite(dead.coveragePct));
});

// ── wiring ───────────────────────────────────────────────────────────────────

test("only a truly empty book parks a symbol", () => {
  // A 429, a timeout or a venue error code must never park an instrument: those
  // are transport faults and the symbol itself is fine.
  const start = SRC.indexOf('if (message === "empty book") {');
  assert.ok(start > 0, "pollSymbol must special-case an empty book");
  const block = SRC.slice(start, SRC.indexOf("\n      return;", start));
  assert.match(block, /st\.emptyBooks\+\+;/);
  assert.match(block, /st\.parkedUntil = now \+ EMPTY_BOOK_PARK_MS;/);
  assert.match(block, /st\.emptyBooks >= EMPTY_BOOK_LIMIT/);
});

test("an empty book is not counted as a failure", () => {
  // Three effects it must not have: the symbol's exponential retry backoff (which
  // stretched three strikes across twenty minutes), the venue's
  // consecutive-failure cooldown, and the venue's status colour.
  const catchStart = SRC.indexOf("  } catch (err) {", SRC.indexOf("async function pollSymbol"));
  const body = SRC.slice(catchStart, SRC.indexOf("  } finally {", catchStart));
  const emptyIdx = body.indexOf('if (message === "empty book") {');
  const returnIdx = body.indexOf("return;", emptyIdx);
  assert.ok(emptyIdx > 0 && returnIdx > emptyIdx, "the empty-book branch must return early");
  const beforeBranch = body.slice(0, emptyIdx);
  assert.ok(!/st\.fails\+\+/.test(beforeBranch), "st.fails must not be bumped before the empty-book check");
  assert.ok(!/exState\.consecutiveFails\+\+/.test(beforeBranch), "the venue counter must not be bumped either");
  assert.ok(!/exState\.status =/.test(beforeBranch), "the venue status must not be set before the check");
  // …and they must still happen for a real fault.
  const afterBranch = body.slice(returnIdx);
  assert.match(afterBranch, /st\.fails\+\+;/);
  assert.match(afterBranch, /exState\.consecutiveFails\+\+;/);
  assert.match(afterBranch, /exState\.status = /);
});

test("one good book clears the counter", () => {
  // Otherwise an instrument that is briefly empty accumulates strikes across
  // hours and eventually parks itself for no reason.
  const start = SRC.indexOf("st.polls++;");
  const block = SRC.slice(start, start + 120);
  assert.match(block, /st\.fails = 0;/);
  assert.match(block, /st\.emptyBooks = 0;/);
});

test("the scheduler skips parked symbols", () => {
  const start = SRC.indexOf("function selectDueSymbols(ex, now)");
  const body = SRC.slice(start, SRC.indexOf("\n}", start));
  assert.match(body, /if \(st\.parkedUntil > now\) continue;/);
});

test("parking is time-boxed and tunable, and a symbol gets another chance", () => {
  const limit = /const EMPTY_BOOK_LIMIT = envInt\("WALL_EMPTY_BOOK_LIMIT", (\d+), (\d+), (\d+)\);/.exec(SRC);
  const park = /const EMPTY_BOOK_PARK_MS = envInt\("WALL_EMPTY_BOOK_PARK_MS", ([^,]+), (\d+), ([^)]+)\);/.exec(SRC);
  assert.ok(limit, "the strike count must be tunable from the environment");
  assert.ok(park, "the park duration must be tunable from the environment");
  assert.ok(Number(limit[1]) >= 2, "a single empty response must not be enough to park");
  const parkMs = new Function(`return ${park[1]};`)();
  assert.ok(parkMs >= 60000 && parkMs <= 24 * 3600 * 1000,
    `park window must be finite so a relisted market recovers (got ${parkMs}ms)`);
  // Fresh state starts unparked.
  assert.match(SRC, /emptyBooks: 0,\s*\/\/ consecutive responses with no levels at all/);
  assert.match(SRC, /parkedUntil: 0,/);
});

test("parking is visible in diagnostics", () => {
  const start = SRC.indexOf("function getSymbolDiagnostics(ex, sym)");
  const body = SRC.slice(start, SRC.indexOf("\n}", start));
  assert.match(body, /emptyBooks: st\.emptyBooks \|\| 0,/);
  assert.match(body, /parkedUntil: st\.parkedUntil \|\| 0,/);
});
