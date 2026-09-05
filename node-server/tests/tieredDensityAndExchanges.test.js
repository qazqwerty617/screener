"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getTierThresholds, classifyWallTier, buildWallSnapshot, minVolumeFor } = require("../wallScanner");

test("BTC density tiers require >=$3M and scale correctly", () => {
  const t = getTierThresholds("BTC", 1_000_000_000);
  assert.equal(t.minFloor, 3_000_000, "BTC floor must be 3M");
  assert.equal(t.small, 3_000_000);
  assert.equal(t.medium, 7_000_000);
  assert.equal(t.large, 15_000_000);

  assert.equal(classifyWallTier(3_500_000, "BTC", 1_000_000_000), "small");
  assert.equal(classifyWallTier(8_000_000, "BTC", 1_000_000_000), "medium");
  assert.equal(classifyWallTier(16_000_000, "BTC", 1_000_000_000), "large");
});

test("ETH density tiers require >=$1.5M and scale correctly", () => {
  const t = getTierThresholds("ETH", 500_000_000);
  assert.equal(t.minFloor, 1_500_000, "ETH floor must be 1.5M");
  assert.equal(classifyWallTier(2_000_000, "ETH", 500_000_000), "small");
  assert.equal(classifyWallTier(5_000_000, "ETH", 500_000_000), "medium");
  assert.equal(classifyWallTier(10_000_000, "ETH", 500_000_000), "large");
});

test("SOL density tiers require >=$800k and scale correctly", () => {
  const t = getTierThresholds("SOL", 200_000_000);
  assert.equal(t.minFloor, 800_000, "SOL floor must be 800k");
  assert.equal(classifyWallTier(1_000_000, "SOL", 200_000_000), "small");
  assert.equal(classifyWallTier(3_000_000, "SOL", 200_000_000), "medium");
  assert.equal(classifyWallTier(6_000_000, "SOL", 200_000_000), "large");
});

test("Mid-cap and small-cap token tiers", () => {
  // Major
  const maj = getTierThresholds("LINK", 30_000_000);
  assert.equal(maj.minFloor, 350_000);

  // Mid-cap
  const mid = getTierThresholds("ARB", 30_000_000);
  assert.equal(mid.minFloor, 100_000);
  assert.equal(classifyWallTier(150_000, "ARB", 30_000_000), "small");
  assert.equal(classifyWallTier(500_000, "ARB", 30_000_000), "medium");
  assert.equal(classifyWallTier(1_200_000, "ARB", 30_000_000), "large");

  // Tail
  const tail = getTierThresholds("XYZ", 1_000_000);
  assert.equal(tail.minFloor, 30_000);
  assert.equal(classifyWallTier(50_000, "XYZ", 1_000_000), "small");
  assert.equal(classifyWallTier(120_000, "XYZ", 1_000_000), "medium");
  assert.equal(classifyWallTier(250_000, "XYZ", 1_000_000), "large");
});

test("buildWallSnapshot filters out sub-3M BTC walls and attaches tier", () => {
  const walls = [
    { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 80000, pct: 0.5, S: 1_800_000, score: 8, v: 1_000_000_000 },
    { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 79000, pct: 0.8, S: 5_000_000, score: 9, v: 1_000_000_000 },
    { base: "SOL", ex: "BN", sym: "SOLUSDT", side: "bid", price: 180, pct: 0.6, S: 220_000, score: 7, v: 200_000_000 },
    { base: "SOL", ex: "BN", sym: "SOLUSDT", side: "bid", price: 175, pct: 1.0, S: 1_200_000, score: 8, v: 200_000_000 },
  ];

  const snap = buildWallSnapshot(walls);
  assert.equal(snap.length, 2, "1.8M BTC and 220k SOL must be rejected");

  const btcWall = snap.find(w => w.base === "BTC");
  assert.ok(btcWall);
  assert.equal(btcWall.S, 5_000_000);
  assert.equal(btcWall.tier, "small");

  const solWall = snap.find(w => w.base === "SOL");
  assert.ok(solWall);
  assert.equal(solWall.S, 1_200_000);
  assert.equal(solWall.tier, "small");
});

test("all-token coverage: minVolumeFor admits tokens with >=50k volume", () => {
  assert.ok(minVolumeFor("BN") <= 50_000);
  assert.ok(minVolumeFor("BB") <= 50_000);
  assert.ok(minVolumeFor("OX") <= 50_000);
  assert.ok(minVolumeFor("BG") <= 50_000);
  assert.ok(minVolumeFor("HT") <= 50_000);
});
