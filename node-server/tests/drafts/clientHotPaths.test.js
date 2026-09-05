"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// Client-side hot-path invariants.
//
// Static verification of the optimisations in public/js/app.js. These are the
// paths that run per animation frame, per WebSocket message, or per second across
// every tracked symbol — the ones where a regression is not a small slowdown but
// a visibly janky UI.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "..", "public");
const APP = fs.readFileSync(path.join(PUB, "js", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(PUB, "css", "app.css"), "utf8");
const FONTS = fs.readFileSync(path.join(PUB, "css", "fonts.css"), "utf8");

/** Strip comments so a comment mentioning an anti-pattern is not a match. */
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1");
}
const APP_CODE = stripJsComments(APP);

/** Extract a top-level `@keyframes name { ... }` block by matching braces. */
function keyframeBlocks(css) {
  const out = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push({ name: m[1], body: css.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

// ── the render loop must stay dirty-flag driven ──────────────────────────────

test("no timer forces a chart repaint or list re-sort on an idle market", () => {
  // A 500ms `chartNeedsDraw = true` and a 2s `needRebuild = true` used to sit in
  // init(), repainting the canvas twice a second and re-sorting 300 rows every
  // two seconds with nothing to show. Every real mutation path already sets the
  // flag; only a slow watchdog is acceptable.
  const forced = [...APP.matchAll(/setInterval\(\s*\(\)\s*=>\s*\{([\s\S]{0,220}?)\}\s*,\s*(\d+)\s*\)/g)];
  for (const [, body, periodStr] of forced) {
    const period = Number(periodStr);
    if (period > 10000) continue; // a slow watchdog is fine
    if (/chartNeedsDraw\s*=\s*true/.test(body) || /needRebuild\s*=\s*true/.test(body)) {
      assert.fail(`a ${period}ms timer force-dirties the render state:\n${body.trim()}`);
    }
  }
});

test("the watchdog that does force a redraw is slow and skips hidden tabs", () => {
  const m = /setInterval\(\(\) => \{\s*\r?\n\s*if \(document\.hidden\) return;\s*\r?\n\s*if \(candles\.length\) chartNeedsDraw = true;\s*\r?\n\s*needRebuild = true;\s*\r?\n\s*\}, (\d+)\);/.exec(APP);
  assert.ok(m, "the render watchdog must bail on document.hidden");
  assert.ok(Number(m[1]) >= 10000, `watchdog period ${m[1]}ms is too aggressive`);
});

test("the 3s multichart redraw skips hidden tabs and inactive views", () => {
  assert.match(APP, /if \(document\.hidden \|\| activeView !== "screener"\) return;/);
});

// ── per-tick DOM access ─────────────────────────────────────────────────────

test("the OHLC/symbol header uses the cached element lookup", () => {
  // updateOHLC -> updateSymInfo -> updateSymInfoInterp runs on every kline and
  // every trade tick. 13 uncached getElementById calls per tick is the cost.
  assert.match(APP, /function \$\$\(id\) \{/, "the caching lookup helper must exist");

  for (const fn of ["function updateOHLC()", "function updateSymInfoInterp(c)"]) {
    const start = APP.indexOf(fn);
    assert.ok(start > 0, `${fn} must exist`);
    const body = APP.slice(start, APP.indexOf("\n}", start));
    const uncached = [...body.matchAll(/(?<![$\w])\$\("/g)];
    assert.equal(uncached.length, 0, `${fn} must not use the uncached $() lookup`);
  }
  // updateSymInfoInterp is the one that actually writes to the DOM.
  const interp = APP.slice(APP.indexOf("function updateSymInfoInterp(c)"));
  assert.ok(/\$\$\("/.test(interp.slice(0, 600)), "the symbol header must use $$()");
});

test("every id read through the element cache exists in the shell", () => {
  // A cached miss stores null permanently, so the field silently stops updating.
  // (updateOHLC used to write five ids that were never in index.html at all.)
  const ids = [...new Set([...APP.matchAll(/\$\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0, "there must be cached lookups to check");
  for (const id of ids) {
    const re = new RegExp(`id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
    assert.match(HTML, re, `#${id} is read from app.js but absent from index.html`);
  }
});

test("the element cache revalidates detached nodes", () => {
  // A cached reference to a node that was replaced would silently stop updating.
  assert.match(APP, /if \(el === undefined \|\| \(el !== null && !el\.isConnected\)\)/);
});

test("exchange status dots are resolved once, not re-queried per message", () => {
  const start = APP.indexOf("function applyExStatusStyles(data)");
  assert.ok(start > 0, "applyExStatusStyles must exist");
  const body = APP.slice(start, APP.indexOf("\n}", start));
  assert.ok(!/querySelector/.test(body), "the status handler must not query the DOM per message");
  assert.match(APP, /function getExcDots\(\)/);
  // and it must not write styles that are already correct
  assert.match(body, /if \(dot\.style\.boxShadow !== "none"\)/);
});

// ── allocation-free numeric hot paths ───────────────────────────────────────

test("correlation uses fixed-capacity rings, not push/shift arrays", () => {
  // `Array.shift` is O(n) and ran once per coin per 5s tick.
  assert.match(APP, /const CORR_SAMPLES = 120;/);
  assert.match(APP, /new Float64Array\(CORR_SAMPLES\)/);
  const start = APP.indexOf("function pearsonCorrelationAbs(x, y)");
  const body = APP.slice(start, APP.indexOf("\n}", start));
  assert.ok(!/\.slice\(/.test(body), "Pearson must not allocate slices per call");
  assert.ok(/x\.len/.test(body) && /y\.len/.test(body), "Pearson must read ring lengths");
});

test("the local correlation pass defers to the server's 24/7 engine", () => {
  // The server computes and pushes the same numbers; recomputing them locally
  // burned O(coins x 240) float ops every 5 seconds for nothing.
  assert.match(APP, /const SERVER_CORR_TRUST_MS = \d+;/);
  assert.match(APP, /if \(Date\.now\(\) - lastServerCorrelationAt < SERVER_CORR_TRUST_MS\)/);
  assert.match(APP, /lastServerCorrelationAt = Date\.now\(\);/);
  // and it must not unconditionally trigger a full re-sort
  const start = APP.indexOf("function updatePriceHistory()");
  const body = APP.slice(start, APP.indexOf("\nsetInterval(updatePriceHistory", start));
  assert.match(body, /if \(changed\) needRebuild = true;/);
});

test("pump/dump price history is a typed ring with a binary search", () => {
  // Was: Map<key, Array<{t,p}>> with shift() plus a full 900-sample linear scan
  // per live tick, driven by a 1s sweep over every coin.
  assert.match(APP, /const PD_RING_CAP = 900;/);
  assert.match(APP, /new Uint32Array\(PD_RING_CAP\)/);
  assert.match(APP, /new Float64Array\(PD_RING_CAP\)/);
  assert.match(APP, /function pdRingFloor\(r, targetSec\)/);
  const start = APP.indexOf("function pdCheckLiveTick(key, currentPrice, ring, now)");
  const body = APP.slice(start, APP.indexOf("\n  }", start));
  assert.ok(!/for \(let i = 0; i < ring\.length/.test(body), "no linear ring scan on the tick path");
  assert.match(body, /pdRingFloor\(ring, targetSec\)/);
});

test("unbounded client-side maps are pruned or capped", () => {
  // Delisted symbols must not retain history forever in a long-lived tab.
  assert.match(APP, /if \(!coins\.has\(key\)\) priceHistories\.delete\(key\)/);
  assert.match(APP, /if \(!window\.coins\.has\(k\)\) pdPriceRing\.delete\(k\)/);
  assert.match(APP, /const PD_COOLDOWN_MAX = \d+;/);
  assert.match(APP, /function pdRememberCooldown\(key, ts\)/);
  // every cooldown write must go through the bounded setter
  const raw = [...APP.matchAll(/pdCooldownMap\.set\(/g)];
  assert.equal(raw.length, 1, "only pdRememberCooldown may write to pdCooldownMap");
});

test("the liquidation map cache key is stable within a bar", () => {
  // Keying on the last *close* changed every tick, so the cache always missed and
  // the whole detector re-ran per frame. The algorithm only reads h/l/v.
  const m = /const key = `liq_\$\{candles\.length\}_\$\{last\.t\}_([^`]*)`/.exec(APP);
  assert.ok(m, "getLiqMapData must build a cache key from the last candle");
  assert.ok(!/last\.c/.test(m[1]), `cache key must not include the live close: ${m[0]}`);
  assert.match(m[1], /last\.h/);
  assert.match(m[1], /last\.l/);
});

test("the open-interest proxy is memoised off the sort comparator", () => {
  // getOiPct runs O(n log n) times per rebuild and built four keys by string
  // concatenation on each call.
  assert.match(APP, /if \(c\._oiProxyStamp === stamp\) return c\._oiProxy;/);
  assert.match(APP, /c\._oiProxyStamp = stamp;/);
});

test("row order is diffed without building a joined key string", () => {
  assert.ok(!APP.includes('sortedList.map(c => c.key).join(",")'), "no per-rebuild string join");
  assert.match(APP, /const prev = cl\._lastOrderKeys;/);
  assert.match(APP, /if \(prev\[i\] !== sortedList\[i\]\.key\) \{ changed = true; break; \}/);
});

test("settings clones use structuredClone, not JSON round-trips", () => {
  assert.equal((APP.match(/JSON\.parse\(JSON\.stringify/g) || []).length, 0);
  assert.ok((APP.match(/structuredClone\(/g) || []).length >= 12);
  // no `structuredClone()` left without an argument
  assert.ok(!/structuredClone\(\s*\)/.test(APP), "structuredClone must be called with a value");
});

// ── leaks ───────────────────────────────────────────────────────────────────

test("ChartInstance removes the window listeners it added", () => {
  // Each grid rebuild disposes and recreates every cell. Without removal, each
  // rebuild permanently added 12 more mousemove handlers, every one doing a
  // getBoundingClientRect() on any mouse move anywhere on the page.
  assert.match(APP, /this\._onWinMouseMove = \(e\) => \{/);
  assert.match(APP, /window\.addEventListener\('mousemove', this\._onWinMouseMove/);
  assert.match(APP, /window\.addEventListener\('mouseup', this\._onWinMouseUp\)/);

  const start = APP.indexOf("  dispose() {");
  assert.ok(start > 0, "dispose() must exist");
  const body = APP.slice(start, APP.indexOf("\n  }", start));
  assert.match(body, /window\.removeEventListener\('mousemove', this\._onWinMouseMove\)/);
  assert.match(body, /window\.removeEventListener\('mouseup', this\._onWinMouseUp\)/);
  assert.match(body, /this\.candles = \[\]/, "dispose must release the candle buffer");
});

test("the window mousemove handler bails before any layout read", () => {
  const start = APP.indexOf("this._onWinMouseMove = (e) => {");
  const body = APP.slice(start, start + 400);
  const guard = /if \(!this\.isRuler && !this\.isDrag && !this\.isDragYScale && !this\.isDragY\) return;/;
  assert.match(body, guard);
  // the guard must come before getBoundingClientRect
  assert.ok(body.search(guard) < body.indexOf("getBoundingClientRect"), "guard must precede the layout read");
});

test("switchView does not register a new interval per visit", () => {
  const start = APP_CODE.indexOf("window.switchView = function switchView(view)");
  const end = APP_CODE.indexOf("\n};", start);
  const body = APP_CODE.slice(start, end);
  assert.ok(!/setInterval/.test(body), "switchView must not create timers — they are never cleared");
});

test("the Gate.io kline ping timer is cleared on every teardown path", () => {
  // fetchKlines nulls klWs.onclose before closing, so an onclose-based cleanup
  // never ran and each coin switch leaked a 15s interval.
  assert.match(APP, /let klWsPingTimer = null;/);
  assert.match(APP, /function clearKlWsPing\(\)/);
  const calls = (APP.match(/clearKlWsPing\(\)/g) || []).length;
  assert.ok(calls >= 4, `clearKlWsPing must be called on every teardown path (found ${calls})`);
});

test("the debug overlay only ticks while it is visible", () => {
  // A 1s innerHTML rebuild used to run unconditionally behind display:none.
  assert.match(APP, /dbgTimer = setInterval\(dbgTick, 1000\);/);
  assert.match(APP, /\} else if \(dbgTimer\) \{\s*\r?\n\s*clearInterval\(dbgTimer\);/);
});

test("the telegram registration poll stops after its deadline", () => {
  assert.match(APP, /clearInterval\(pollInterval\);\s*\r?\n\s*return; \/\/ without this the timed-out poll still fired one more request/);
});

test("pump/dump cards coalesce into one frame and skip a closed panel", () => {
  assert.match(APP, /function pdScheduleRenderCards\(\)/);
  assert.match(APP, /if \(wrap && !wrap\.classList\.contains\("open"\)\) return;/);
  const start = APP.indexOf("function pdAddCard(data)");
  const body = APP.slice(start, APP.indexOf("\n  }", start));
  assert.match(body, /pdScheduleRenderCards\(\);/, "pdAddCard must not render synchronously");
});

// ── dead code that changed behaviour ────────────────────────────────────────

test("getClampedOffsetX is defined exactly once", () => {
  // Two module-scope declarations existed with different clamps; hoisting made
  // the later one silently win, so the first one's future headroom never applied.
  const defs = (APP.match(/function getClampedOffsetX\(/g) || []).length;
  assert.equal(defs, 1, "duplicate hoisted definitions silently override each other");
  assert.match(APP, /if \(!Number\.isFinite\(val\) \|\| !candles \|\| !candles\.length\) return 0;/);
});

test("the price-alert toast navigates to a function that exists", () => {
  // The chart-drawing branch read `alert.ex` with no `alert` in scope, so it
  // resolved to window.alert and both values were undefined. And the guard named
  // `loadCoinChart`, which does not exist anywhere.
  assert.ok(!/typeof loadCoinChart === "function"/.test(APP), "loadCoinChart does not exist");
  assert.equal((APP.match(/window\.openCoinChart\(alertExVal, alertSymVal\)/g) || []).length, 2);
  assert.match(APP, /const alertExVal = ex \|\| activeEx;/);
  assert.match(APP, /const alertSymVal = sym \|\| activeSym;/);
});

test("unreferenced helpers are gone", () => {
  assert.ok(!/function startMcLoop\(\)/.test(APP), "startMcLoop was an empty deprecated stub");
  assert.ok(!/function processTickerUpdate\(t\)/.test(APP), "processTickerUpdate had no callers");
  assert.ok(!/const pdKlinesCache/.test(APP), "pdKlinesCache was never read");
});

// ── document / assets ───────────────────────────────────────────────────────

test("every app script is deferred and the preload matches", () => {
  const tags = HTML.match(/<script[^>]*src="\/js\/[^"]*"[^>]*>/g) || [];
  assert.ok(tags.length >= 7, `expected the full script set, found ${tags.length}`);
  for (const tag of tags) {
    assert.match(tag, /\bdefer\b/, `blocking script tag: ${tag}`);
  }
  const preload = /rel="preload"[^>]*\/js\/app\.js\?v=(\d+)/.exec(HTML);
  const script = /<script[^>]*src="\/js\/app\.js\?v=(\d+)"/.exec(HTML);
  assert.ok(preload && script, "app.js must be preloaded and scripted");
  assert.equal(preload[1], script[1], "a version mismatch downloads app.js twice");
});

test("the shell declares its charset and drops the redundant font CDN", () => {
  assert.match(HTML, /<meta charset="utf-8"\s*\/?>/i);
  assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(HTML),
    "fonts.css already self-hosts these exact faces");
});

test("fonts.css uses variable weight ranges instead of one block per weight", () => {
  const code = FONTS.replace(/\/\*[\s\S]*?\*\//g, "");
  const faces = (code.match(/@font-face/g) || []).length;
  assert.ok(faces <= 16, `${faces} @font-face blocks — was 79 (13 files repeated per weight)`);
  assert.match(code, /font-weight:\s*300 900/);
  assert.ok(!/url\((["']?)https?:/.test(code), "no external font source");
  assert.ok(!/@import/.test(code));
});

test("app.css does not @import fonts.css", () => {
  // An @import serialises the request behind app.css and hides it from the
  // preload scanner; index.html links it directly instead.
  assert.ok(!/@import[^;]*fonts\.css/.test(CSS));
});

test("shipped icons are raster-sized, not 443 KB full-resolution art", () => {
  const size = (p) => fs.statSync(path.join(PUB, p)).size;
  assert.ok(size("favicon.ico") < 20_000, `favicon.ico ${size("favicon.ico")}B`);
  assert.ok(size("apple-touch-icon.png") < 25_000, `apple-touch-icon ${size("apple-touch-icon.png")}B`);
  assert.ok(size("img/logo.png") < 10_000, `header logo ${size("img/logo.png")}B`);
  assert.ok(!fs.existsSync(path.join(PUB, "favicon.svg")), "the 591 KB SVG favicon must be gone");
  assert.ok(!fs.existsSync(path.join(PUB, "img/logo.svg")), "the 591 KB SVG logo must be gone");
  assert.ok(!fs.existsSync(path.join(PUB, "apple-touch-icon-precomposed.png")), "duplicate icon");
  // manifest must only reference icons that exist
  const manifest = JSON.parse(fs.readFileSync(path.join(PUB, "manifest.json"), "utf8"));
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(PUB, icon.src.replace(/^\//, ""))), `missing ${icon.src}`);
  }
});

// ── CSS paint cost ──────────────────────────────────────────────────────────

test("no rule transitions every property", () => {
  assert.equal((CSS.match(/transition:\s*all\b/g) || []).length, 0);
  // and the property-less shorthand (`transition: .3s ease`) means `all` too
  const blanket = [...CSS.matchAll(/transition:\s*([^;}]*)/g)].filter(([, v]) => {
    const parts = v.split(/,(?![^(]*\))/);
    if (parts.length !== 1) return false;
    const toks = parts[0].replace(/\b(?:cubic-bezier|steps)\([^)]*\)/g, " ").trim().split(/\s+/);
    return toks.every((t) => /^[.0-9]/.test(t) || /^(linear|ease|ease-in|ease-out|ease-in-out|!important)$/i.test(t));
  });
  assert.deepEqual(blanket.map((m) => m[0]), [], "property-less transition shorthand means `all`");
});

test("every transition declaration names a property and a duration", () => {
  for (const [, value] of CSS.matchAll(/(?:-webkit-)?transition:\s*([^;}]*)/g)) {
    for (const part of value.split(/,(?![^(]*\))/)) {
      const toks = part.replace(/\b(?:cubic-bezier|steps)\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
      if (!toks.length) continue;
      const hasTime = toks.some((t) => /^[.0-9]+m?s$/.test(t));
      const hasProp = toks.some((t) => /^-?[a-z][a-z-]*$/.test(t)
        && !/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|none|normal|!important)$/i.test(t));
      assert.ok(hasTime && hasProp, `malformed transition part: ${JSON.stringify(part)} in "${value}"`);
    }
  }
});

test("no animation drives a blur, box-shadow or layout property", () => {
  // Animating backdrop-filter re-runs a full-viewport blur every frame; animating
  // box-shadow or a geometry property repaints or relayouts every frame.
  for (const { name, body } of keyframeBlocks(CSS)) {
    for (const prop of ["backdrop-filter", "box-shadow", "width", "height"]) {
      assert.ok(!new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(body),
        `@keyframes ${name} animates ${prop}`);
    }
  }
});

test("the permanent connection pulse is compositor-only", () => {
  // `.conn-dot.ok` keeps its class for the whole session, so this animation never
  // stops. It must not repaint.
  const m = /@keyframes conn-pulse \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(m, "conn-pulse must exist");
  assert.match(m[1], /transform:/);
  assert.match(m[1], /opacity:/);
  assert.ok(!/box-shadow:/.test(m[1]), "must not animate box-shadow");
  assert.match(CSS, /\.conn-dot\.ok::after \{/, "the pulse must live on a pseudo-element");
});

test("the toast progress bar animates transform, not width", () => {
  const m = /@keyframes toastProgress \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(m);
  assert.match(m[1], /scaleX/);
  assert.match(CSS, /\.toast-progress \{[\s\S]*?transform-origin: left center;/);
});

test("the journal stylesheet block is not duplicated", () => {
  // ~200 lines were pasted twice, including `.j-modal-overlay` with a
  // full-viewport backdrop-filter.
  for (const sel of [".j-modal-overlay", ".j-api-grid", ".j-pnl-card-preview", ".j-chart-box canvas"]) {
    const n = (CSS.match(new RegExp(`(^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "g")) || []).length;
    assert.equal(n, 1, `${sel} is declared ${n} times`);
  }
});
