"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("formation maps cache file path is defined", () => {
  assert.match(SRC, /const FORMATION_CACHE_FILE = path\.join\(__dirname, "formation_maps_cache\.json"\);/);
});

test("formation maps are loaded at startup", () => {
  assert.match(SRC, /function loadFormationMaps\(\)/);
  assert.match(SRC, /loadFormationMaps\(\);/);
});

test("formation maps are saved periodically and on graceful shutdown", () => {
  assert.match(SRC, /function saveFormationMaps\(force = false\)/);
  assert.match(SRC, /saveFormationMaps\(false\);/);
  assert.match(SRC, /saveFormationMaps\(true\);/);
});

test("formation maps cache write is atomic with .tmp rename", () => {
  const m = /function saveFormationMaps\(force = false\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(m, "saveFormationMaps must exist");
  assert.match(m[0], /const tmp = `\$\{FORMATION_CACHE_FILE\}\.tmp`;/);
  assert.match(m[0], /fs\.renameSync\(tmp, FORMATION_CACHE_FILE\);/);
});

test("4h patterns scanner is scheduled and available", () => {
  assert.match(SRC, /async function scan4hPatterns\(\)/);
  assert.match(SRC, /setTimeout\(scan4hPatterns, 5000\);/);
});
