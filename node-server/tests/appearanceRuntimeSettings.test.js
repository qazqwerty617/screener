"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/css/app.css"), "utf8");

test("compact-list switch previews a visibly denser row layout", () => {
  assert.match(app, /compactEl\.onchange\s*=\s*\(\)\s*=>\s*applyCompactList\(compactEl\.checked\)/);
  assert.match(app, /function applyCompactList\(enabled\)[\s\S]*?classList\.toggle\("compact",\s*Boolean\(enabled\)\)/);
  assert.match(css, /#coin-list\.compact\s+\.cr\s*\{[^}]*height:\s*24px[^}]*padding:\s*1px\s+6px/s);
  assert.match(css, /#coin-list\.compact\s+\.cdot\s*\{[^}]*width:\s*18px[^}]*height:\s*12px/s);
});

test("chart-animation switch controls the interpolation path instead of a dead variable", () => {
  assert.match(app, /animEl\.onchange\s*=\s*\(\)\s*=>\s*setChartAnimationsEnabled\(animEl\.checked\)/);
  assert.match(app, /function setChartAnimationsEnabled\(enabled\)[\s\S]*?interpActive\.clear\(\)/);
  assert.match(app, /const factor = 1 - Math\.exp\(-INTERP_SPEED \* clampedDt\)/);
  assert.match(app, /function scheduleInterp\(key\)[\s\S]*?if \(!chartAnimationsEnabled\)[\s\S]*?c\.displayP = c\.p/s);
});

test("reset all restores every settings section and its visible controls", () => {
  const reset = app.match(/resetBtn\.onclick\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};\n\s*\}/)?.[1] || "";
  assert.match(reset, /selectAppearanceTheme\("obsidian"\)/);
  assert.match(reset, /Object\.assign\(formationColorState, DEFAULT_FORMATION_COLORS\)/);
  assert.match(reset, /visibleCols\s*=\s*\{\s*\.\.\.defaultCols\s*\}/);
  assert.match(reset, /updateTableGrid\(\)/);
  assert.match(reset, /window\.pdResetToDefaults\?\.\(\)/);
  assert.match(reset, /schedulePreferencesSync\(\)/);
  assert.match(reset, /closeSettingsModal\(\)/);
  assert.match(app, /function pdResetToDefaults\(\)[\s\S]*?pdSettings\s*=\s*JSON\.parse\(JSON\.stringify\(DEFAULT_PD_SETTINGS\)\)[\s\S]*?pdSave\(pdSettings\)[\s\S]*?pdSyncModalUI\(pdDraftSettings\)/);
});
