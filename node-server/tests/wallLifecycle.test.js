"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ingestBook,
  getSymbolDiagnostics,
  resetSymbolState,
  getWallHistorySnapshot,
} = require("../wallScanner");

// ── Book builders ────────────────────────────────────────────────────────────

let seedCounter = 0;
function makeSide(mid, side, opts) {
  const { step = 0.01, levels = 200, baseUsd = 3000, jitter = 0.12 } = opts || {};
  let seed = 1337 + (seedCounter++ % 7);
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out = [];
  for (let i = 1; i <= levels; i++) {
    const price = side === "bid"
      ? +(mid - i * step).toFixed(8)
      : +(mid + i * step).toFixed(8);
    const usd = baseUsd * (1 + (rand() - 0.5) * jitter * 2);
    out.push({ price, qty: usd / price, usd });
  }
  return out;
}

/**
 * mid, plus an optional wall of `wallUsd` at `wallPrice` on `wallSide`.
 * A wallUsd of 0 means the level is gone entirely.
 */
function buildBook(opts) {
  const { mid = 100, wallSide = "bid", wallPrice = 99.5, wallUsd = 0, step = 0.01 } = opts || {};
  const bids = makeSide(mid, "bid", { step });
  const asks = makeSide(mid, "ask", { step });

  if (wallUsd > 0) {
    const list = wallSide === "bid" ? bids : asks;
    let best = null;
    let bestDist = Infinity;
    for (const level of list) {
      const dist = Math.abs(level.price - wallPrice);
      if (dist < bestDist) { bestDist = dist; best = level; }
    }
    if (best) {
      best.usd += wallUsd;
      best.qty = best.usd / best.price;
    }
  }
  return { bids, asks };
}

const EX = "BN";
const SYM = "LIFEUSDT";
const COIN = { sym: SYM, base: "LIFE", p: 100, v: 40_000_000, cs: 1 };

function coinAt(mid) {
  return { ...COIN, p: mid };
}

function reset() {
  resetSymbolState(EX, SYM);
}

function feed(opts, now) {
  return ingestBook({ ex: EX, coin: coinAt(opts.mid || 100), now, ...buildBook(opts) });
}

// ── Persistence / anti-spoof ─────────────────────────────────────────────────

test("a single sighting is never published (anti-flicker confirmation gate)", () => {
  reset();
  const t0 = 1_000_000;
  // A level seen exactly once could be a transient order that happened to look
  // large for one refresh. Publishing it is what made the map churn.
  const walls = feed({ wallUsd: 900_000 }, t0);
  assert.deepEqual(walls, []);
});

test("a level is published only after three confirmations", () => {
  reset();
  let t = 1_100_000;
  feed({ wallUsd: 900_000 }, t); t += 20_000;
  feed({ wallUsd: 900_000 }, t); t += 20_000;
  const walls = feed({ wallUsd: 900_000 }, t);

  const wall = walls.find(w => w.side === "bid");
  assert.ok(wall, "wall must appear once confirmed");
  assert.equal(wall.confirmations, 3);
  assert.ok(wall.persistence < 0.35, `persistence too high when barely confirmed: ${wall.persistence}`);
  // firstSeenAt must point at the original sighting, not the confirming poll.
  assert.equal(wall.firstSeenAt, 1_100_000);
});

test("persistence, confirmations and score all rise as a level survives", () => {
  reset();
  let t = 2_000_000;
  let first = null;
  let last = null;

  for (let i = 0; i < 8; i++) {
    const walls = feed({ wallUsd: 900_000 }, t);
    const wall = walls.find(w => w.side === "bid");
    if (i === 0) {
      // Held back by the confirmation gate.
      assert.equal(wall, undefined);
    } else if (i === 1) {
      assert.equal(wall, undefined, "two sightings must still be held behind the anti-spoof gate");
    } else {
      assert.ok(wall, `wall lost on poll ${i}`);
      if (!first) first = wall;
      last = wall;
    }
    t += 20_000;
  }

  assert.equal(first.confirmations, 3);
  assert.ok(last.confirmations >= 8, `confirmations=${last.confirmations}`);
  assert.ok(last.persistence > first.persistence);
  // Same raw book, so the increase must come purely from confirmed survival.
  assert.ok(last.score > first.score, `${last.score} <= ${first.score}`);
  assert.ok(last.age >= 120, `age=${last.age}`);
});

test("a level yanked while price stayed far away is classified as pulled (spoof)", () => {
  reset();
  let t = 3_000_000;

  // Establish the level well away from the mid.
  for (let i = 0; i < 3; i++) {
    feed({ mid: 100, wallUsd: 900_000, wallPrice: 98.2 }, t);
    t += 20_000;
  }

  // It vanishes without price ever approaching it.
  for (let i = 0; i < 4; i++) {
    feed({ mid: 100, wallUsd: 0 }, t);
    t += 20_000;
  }

  const diag = getSymbolDiagnostics(EX, SYM);
  assert.ok(diag.pulled >= 1, `expected a pulled classification, got ${JSON.stringify(diag)}`);
  assert.equal(diag.filled, 0);
});

test("a level consumed by price is classified as filled, not pulled", () => {
  reset();
  let t = 4_000_000;

  // Level at 99.90, price starts at 100.
  for (let i = 0; i < 3; i++) {
    feed({ mid: 100, wallUsd: 900_000, wallPrice: 99.9 }, t);
    t += 20_000;
  }

  // Price walks down onto the level, then it is gone.
  feed({ mid: 99.95, wallUsd: 900_000, wallPrice: 99.9 }, t); t += 20_000;
  for (let i = 0; i < 4; i++) {
    feed({ mid: 99.9, wallUsd: 0 }, t);
    t += 20_000;
  }

  const diag = getSymbolDiagnostics(EX, SYM);
  assert.ok(diag.filled + diag.faded >= 1, `expected filled/faded, got ${JSON.stringify(diag)}`);
});

test("a symbol with a high pull rate has its densities discounted", () => {
  reset();
  let t = 5_000_000;

  // Repeatedly plant a far-away level and yank it: classic spoofing pattern.
  for (let cycle = 0; cycle < 5; cycle++) {
    for (let i = 0; i < 2; i++) {
      feed({ mid: 100, wallUsd: 900_000, wallPrice: 98.0 + cycle * 0.01 }, t);
      t += 20_000;
    }
    for (let i = 0; i < 4; i++) {
      feed({ mid: 100, wallUsd: 0 }, t);
      t += 20_000;
    }
  }

  const spoofy = getSymbolDiagnostics(EX, SYM);
  assert.ok(spoofy.pulled >= 3, `expected several pulls, got ${JSON.stringify(spoofy)}`);
  assert.ok(spoofy.pullRate > 0.5, `pullRate=${spoofy.pullRate}`);

  // Three polls so the level clears the anti-spoof gate on both symbols.
  feed({ mid: 100, wallUsd: 900_000, wallPrice: 99.3 }, t); t += 20_000;
  feed({ mid: 100, wallUsd: 900_000, wallPrice: 99.3 }, t); t += 20_000;
  const spoofWalls = feed({ mid: 100, wallUsd: 900_000, wallPrice: 99.3 }, t);
  const spoofWall = spoofWalls.find(w => w.side === "bid");

  // A clean symbol with the identical book must score higher.
  const CLEAN_SYM = "CLEANUSDT";
  const CLEAN_COIN = { sym: CLEAN_SYM, base: "CLEAN", p: 100, v: 40_000_000, cs: 1 };
  resetSymbolState(EX, CLEAN_SYM);
  ingestBook({
    ex: EX,
    coin: CLEAN_COIN,
    now: t - 40_000,
    ...buildBook({ mid: 100, wallUsd: 900_000, wallPrice: 99.3 }),
  });
  ingestBook({
    ex: EX,
    coin: CLEAN_COIN,
    now: t - 20_000,
    ...buildBook({ mid: 100, wallUsd: 900_000, wallPrice: 99.3 }),
  });
  const cleanWalls = ingestBook({
    ex: EX,
    coin: CLEAN_COIN,
    now: t,
    ...buildBook({ mid: 100, wallUsd: 900_000, wallPrice: 99.3 }),
  });
  const cleanWall = cleanWalls.find(w => w.side === "bid");

  assert.ok(cleanWall, "the clean symbol's density must be published");
  // The spoof-heavy symbol is either suppressed entirely by the quality gate or
  // published with a strictly lower score. Both are correct outcomes.
  if (spoofWall) {
    assert.ok(spoofWall.pullRate > cleanWall.pullRate);
    assert.ok(
      spoofWall.score < cleanWall.score,
      `spoof-heavy symbol should score lower: ${spoofWall.score} vs ${cleanWall.score}`
    );
  }
  resetSymbolState(EX, CLEAN_SYM);
});

// ── Absorption and refills ───────────────────────────────────────────────────

test("eatenPct tracks how much of the peak has been absorbed", () => {
  reset();
  let t = 6_000_000;

  feed({ wallUsd: 1_000_000 }, t); t += 20_000;
  feed({ wallUsd: 1_000_000 }, t); t += 20_000;
  const walls = feed({ wallUsd: 400_000 }, t);
  const wall = walls.find(w => w.side === "bid");
  assert.ok(wall, "shrunken wall should still be reported");
  assert.ok(wall.eatenPct > 40, `eatenPct=${wall.eatenPct}`);
  assert.ok(wall.peakUsd > wall.S);
});

test("a level that is eaten down then restored is counted as a refill", () => {
  reset();
  let t = 7_000_000;

  feed({ wallUsd: 1_000_000 }, t); t += 20_000;
  feed({ wallUsd: 300_000 }, t); t += 20_000;   // eaten well below the dip ratio
  const walls = feed({ wallUsd: 950_000 }, t);  // restored

  const wall = walls.find(w => w.side === "bid");
  assert.ok(wall, "refilled wall must be present");
  assert.ok(wall.refills >= 1, `refills=${wall.refills}`);
});

// ── Signal fields ────────────────────────────────────────────────────────────

test("published densities carry the full professional signal set", () => {
  reset();
  feed({ wallUsd: 900_000 }, 8_000_000);
  feed({ wallUsd: 900_000 }, 8_020_000);
  const walls = feed({ wallUsd: 900_000 }, 8_040_000);
  const wall = walls.find(w => w.side === "bid");
  assert.ok(wall);

  for (const field of [
    "base", "ex", "sym", "side", "market", "price", "S", "wallK", "pct",
    "score", "rtwi", "significance", "rank", "persistence", "confirmations",
    "dominance", "depthShare", "volMinutes", "percentile", "relSize", "z",
    "eatenPct", "peakUsd", "maxSizeUsd", "pullRate", "refills",
    "firstSeenAt", "lastSeenAt", "lifeMs", "age", "count", "widthPct",
    "mid", "spreadPct", "bookImbalance", "active",
  ]) {
    assert.ok(field in wall, `missing field: ${field}`);
  }

  assert.equal(wall.market, "futures");
  assert.equal(wall.ex, EX);
  assert.ok(wall.rank >= 2 && wall.rank <= 10);
  assert.ok(wall.significance > 0 && wall.significance <= 1);
  // rtwi is kept as an alias so existing frontend sorting keeps working.
  assert.equal(wall.rtwi, wall.score);
});

test("spot symbols are labelled as the spot market", () => {
  const SPOT_SYM = "SPOTCOINUSDT_SPOT";
  const SPOT_COIN = { sym: SPOT_SYM, base: "SPOTCOIN", p: 100, v: 20_000_000, cs: 1 };
  resetSymbolState(EX, SPOT_SYM);
  ingestBook({ ex: EX, coin: SPOT_COIN, now: 9_000_000, ...buildBook({ wallUsd: 900_000 }) });
  ingestBook({ ex: EX, coin: SPOT_COIN, now: 9_020_000, ...buildBook({ wallUsd: 900_000 }) });
  const walls = ingestBook({ ex: EX, coin: SPOT_COIN, now: 9_040_000, ...buildBook({ wallUsd: 900_000 }) });
  const wall = walls.find(w => w.side === "bid");
  assert.ok(wall);
  assert.equal(wall.market, "spot");
  resetSymbolState(EX, SPOT_SYM);
});

test("a bid wall and an ask wall are tracked independently", () => {
  reset();
  let t = 10_000_000;
  const build = () => {
    const bids = makeSide(100, "bid", {});
    const asks = makeSide(100, "ask", {});
    bids[49].usd += 900_000; bids[49].qty = bids[49].usd / bids[49].price;
    asks[49].usd += 900_000; asks[49].qty = asks[49].usd / asks[49].price;
    return { bids, asks };
  };

  ingestBook({ ex: EX, coin: coinAt(100), now: t, ...build() });
  t += 20_000;
  ingestBook({ ex: EX, coin: coinAt(100), now: t, ...build() });
  t += 20_000;
  const walls = ingestBook({ ex: EX, coin: coinAt(100), now: t, ...build() });
  assert.ok(walls.some(w => w.side === "bid"));
  assert.ok(walls.some(w => w.side === "ask"));
});

// ── Stability / anti-flicker ─────────────────────────────────────────────────

test("a level that keeps reappearing at the same price is not re-created", () => {
  reset();
  let t = 15_000_000;
  let firstId = null;

  for (let i = 0; i < 6; i++) {
    // The volume-weighted cluster price drifts slightly between polls, which is
    // exactly the case that must not spawn a new level each time.
    const walls = feed({ wallUsd: 900_000 + i * 4_000 }, t);
    const wall = walls.find(w => w.side === "bid");
    if (wall) {
      if (!firstId) firstId = wall.wallId;
      assert.equal(wall.wallId, firstId, `identity changed on poll ${i}`);
    }
    t += 20_000;
  }
  assert.ok(firstId, "a level must have been published");
});

test("score is smoothed so a noisy book does not make it swing", () => {
  reset();
  let t = 16_000_000;
  // Warm up past the confirmation gate.
  feed({ wallUsd: 900_000 }, t); t += 20_000;
  feed({ wallUsd: 900_000 }, t); t += 20_000;

  const scores = [];
  // Alternate the wall size hard on every poll.
  for (let i = 0; i < 6; i++) {
    const walls = feed({ wallUsd: i % 2 ? 1_600_000 : 700_000 }, t);
    const wall = walls.find(w => w.side === "bid");
    if (wall) scores.push(wall.score);
    t += 20_000;
  }

  assert.ok(scores.length >= 4, "the level must stay published throughout");
  let maxJump = 0;
  for (let i = 1; i < scores.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(scores[i] - scores[i - 1]));
  }
  // Without EMA smoothing this book swings the score by several points per poll.
  assert.ok(maxJump < 2.5, `score jumped by ${maxJump.toFixed(2)} between polls`);
});

// ── History ──────────────────────────────────────────────────────────────────

test("history records a level and marks it inactive once it is resolved", () => {
  reset();
  let t = 11_000_000;

  for (let i = 0; i < 3; i++) {
    feed({ wallUsd: 900_000, wallPrice: 98.3 }, t);
    t += 20_000;
  }

  const live = getWallHistorySnapshot(t).filter(r => r.sym === SYM);
  assert.ok(live.length >= 1, "history must contain the live level");
  assert.ok(live.some(r => r.active));

  for (let i = 0; i < 4; i++) {
    feed({ wallUsd: 0 }, t);
    t += 20_000;
  }

  const resolved = getWallHistorySnapshot(t).filter(r => r.sym === SYM);
  assert.ok(resolved.some(r => !r.active && r.endedAt), "level must be closed in history");
  const closed = resolved.find(r => !r.active);
  assert.ok(closed.endReason, "an end reason must be recorded");
  assert.ok(closed.maxSizeUsd > 0);
});

// ── Robustness ───────────────────────────────────────────────────────────────

test("an empty book clears the symbol's densities without throwing", () => {
  reset();
  feed({ wallUsd: 900_000 }, 12_000_000);
  const cleared = ingestBook({ ex: EX, coin: COIN, bids: [], asks: [], now: 12_020_000 });
  assert.deepEqual(cleared, []);
});

test("repeated ingest of the same timestamp does not corrupt counters", () => {
  reset();
  const t = 13_000_000;
  feed({ wallUsd: 900_000 }, t);
  feed({ wallUsd: 900_000 }, t);
  feed({ wallUsd: 900_000 }, t);
  const diag = getSymbolDiagnostics(EX, SYM);
  assert.ok(diag.trackedLevels >= 1);
  assert.equal(diag.pulled, 0);
});

test("tracked level count stays bounded on a pathological book", () => {
  reset();
  let t = 14_000_000;
  // Every poll moves the wall to a new price: worst case for level tracking.
  for (let i = 0; i < 60; i++) {
    feed({ mid: 100, wallUsd: 900_000, wallPrice: +(99.0 + i * 0.005).toFixed(4) }, t);
    t += 20_000;
  }
  const diag = getSymbolDiagnostics(EX, SYM);
  assert.ok(diag.trackedLevels <= 400, `trackedLevels=${diag.trackedLevels}`);
});
