"use strict";
// ═══════════════════════════════════════════════════════════════════════════════
// Static asset freshness.
//
// `staticCache` is filled once at boot and every asset request is answered from
// it. Nothing re-read the files, so an edit to public/js/app.js or
// public/css/app.css was invisible until the process restarted — while versioned
// URLs (`?v=`) are served `immutable, max-age=31536000`. A browser that fetched
// pre-edit bytes under a post-edit version string therefore pinned a stale
// bundle for a year, which no server restart could dislodge: the density map ran
// old client code against the current engine and drew nothing.
//
// The real functions are extracted from server.js and driven against a temp
// directory, so these assertions break if the invalidation is removed.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createHash } = require("crypto");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function grab(re, what) {
  const m = re.exec(SRC);
  assert.ok(m, `${what} must exist in server.js`);
  return m[0];
}

/** Rebuild the real static-cache layer over `rootDir/public`. */
function buildHarness(rootDir) {
  const body = `
    const staticCache = new Map();
    ${grab(/const BROTLI_QUALITY = \d+;/, "BROTLI_QUALITY")}
    ${grab(/const BROTLI_TEXT_EXT = new Set\(\[[\s\S]*?\]\);/, "BROTLI_TEXT_EXT")}
    ${grab(/const NO_RECOMPRESS_EXT = new Set\(\[[\s\S]*?\]\);/, "NO_RECOMPRESS_EXT")}
    ${grab(/function brotliOf\(raw\) \{[\s\S]*?\n\}/, "brotliOf")}
    ${grab(/const STATIC_MIME_TYPES = \{[\s\S]*?\n\};/, "STATIC_MIME_TYPES")}
    ${grab(/function preCompressStatic\(relPath, withBrotli = true\) \{[\s\S]*?\n\}/, "preCompressStatic")}
    ${grab(/const STATIC_REVALIDATE_MS = \d+;/, "STATIC_REVALIDATE_MS")}
    ${grab(/function freshStatic\(relPath\) \{[\s\S]*?\n\}/, "freshStatic")}
    return { staticCache, preCompressStatic, freshStatic, STATIC_REVALIDATE_MS };
  `;
  return new Function("fs", "path", "zlib", "createHash", "__dirname", body)(fs, path, zlib, createHash, rootDir);
}

function tempPublic() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "static-fresh-"));
  fs.mkdirSync(path.join(root, "public", "js"), { recursive: true });
  return root;
}

/** Write a file and force a distinct mtime, so coarse timestamps cannot mask an edit. */
function writeAsset(root, rel, text, mtimeShiftSec = 0) {
  const abs = path.join(root, "public", rel);
  fs.writeFileSync(abs, text);
  if (mtimeShiftSec) {
    const when = new Date(Date.now() + mtimeShiftSec * 1000);
    fs.utimesSync(abs, when, when);
  }
  return abs;
}

test("an edited asset is re-read, re-etagged and re-compressed", () => {
  const root = tempPublic();
  const h = buildHarness(root);
  writeAsset(root, "js/app.js", "console.log('v1');\n");
  h.preCompressStatic("js/app.js");

  const first = h.freshStatic("js/app.js");
  assert.ok(first, "asset must be cached after preCompressStatic");
  assert.match(first.raw.toString(), /v1/);
  assert.ok(first.brotli && first.gzipped, "text assets keep both encodings");

  writeAsset(root, "js/app.js", "console.log('v2 — the fix the user is waiting for');\n", 5);
  // Simulate the next request arriving after the revalidation window.
  h.staticCache.get("js/app.js").checkedAt = 0;

  const second = h.freshStatic("js/app.js");
  assert.match(second.raw.toString(), /v2/, "the edit must reach the response body");
  assert.notEqual(second.etag, first.etag, "a new body must produce a new ETag");
  assert.ok(second.brotli, "brotli must be regenerated, not dropped, after an edit");
  assert.equal(zlib.brotliDecompressSync(second.brotli).toString(), second.raw.toString());
  assert.equal(zlib.gunzipSync(second.gzipped).toString(), second.raw.toString());
});

test("an edit that keeps the byte count is still detected", () => {
  const root = tempPublic();
  const h = buildHarness(root);
  writeAsset(root, "js/app.js", "const densityMaxDistance = 3;\n");
  h.preCompressStatic("js/app.js");
  const before = h.freshStatic("js/app.js").etag;

  writeAsset(root, "js/app.js", "const densityMaxDistance = 5;\n", 5);
  h.staticCache.get("js/app.js").checkedAt = 0;

  const after = h.freshStatic("js/app.js");
  assert.match(after.raw.toString(), /= 5;/);
  assert.notEqual(after.etag, before);
});

test("an untouched asset is served from memory, not re-read", () => {
  const root = tempPublic();
  const h = buildHarness(root);
  writeAsset(root, "js/app.js", "console.log('stable');\n");
  h.preCompressStatic("js/app.js");

  const first = h.freshStatic("js/app.js");
  h.staticCache.get("js/app.js").checkedAt = 0; // force the stat path
  const second = h.freshStatic("js/app.js");
  assert.equal(second, first, "an unchanged file must return the same cached entry");
  assert.equal(second.raw, first.raw, "no buffer should be re-allocated for an unchanged file");
});

test("revalidation is throttled, and a deleted asset is dropped", () => {
  const root = tempPublic();
  const h = buildHarness(root);
  const abs = writeAsset(root, "js/app.js", "console.log('doomed');\n");
  h.preCompressStatic("js/app.js");
  assert.ok(h.STATIC_REVALIDATE_MS >= 1000, "one stat per asset per second is the intended ceiling");

  fs.unlinkSync(abs);
  assert.ok(h.freshStatic("js/app.js"), "inside the window the cached copy is served without a stat");

  h.staticCache.get("js/app.js").checkedAt = 0;
  assert.equal(h.freshStatic("js/app.js"), undefined, "a deleted asset must fall through, not be served from memory");
  assert.equal(h.staticCache.has("js/app.js"), false, "and must be evicted from the cache");
});

test("preCompressStatic stamps the file identity it read", () => {
  const root = tempPublic();
  const h = buildHarness(root);
  writeAsset(root, "js/app.js", "console.log('stamped');\n");
  h.preCompressStatic("js/app.js");

  const entry = h.staticCache.get("js/app.js");
  const stat = fs.statSync(path.join(root, "public", "js", "app.js"));
  assert.equal(entry.mtimeMs, stat.mtimeMs);
  assert.equal(entry.size, stat.size);
  assert.equal(typeof entry.checkedAt, "number");
  // Statting before the read is what keeps an edit racing the read detectable.
  const fn = grab(/function preCompressStatic\(relPath, withBrotli = true\) \{[\s\S]*?\n\}/, "preCompressStatic");
  assert.ok(fn.indexOf("statSync") < fn.indexOf("readFileSync"), "stat must happen before the read");
});

// ── the serving paths must go through the revalidating lookup ────────────────

test("both asset response paths revalidate instead of trusting the boot snapshot", () => {
  const mw = SRC.slice(SRC.indexOf("// Serve pre-compressed assets"), SRC.indexOf("app.use(express.static("));
  assert.match(mw, /const cached = freshStatic\(urlPath\);/);
  assert.ok(!/staticCache\.get\(/.test(mw), "the hot asset path must not read the raw cache");

  const shell = SRC.slice(SRC.indexOf('app.get("*"'), SRC.indexOf("// Any unhandled error returns"));
  assert.match(shell, /const shell = freshStatic\("index\.html"\);/);
  assert.ok(!/staticCache\.get\(/.test(shell), "deep links must not serve a shell older than / does");
});

test("versioned assets stay immutable and the shell stays uncacheable", () => {
  // The long cache is what makes freshness on the server side non-negotiable:
  // one stale response under a new `?v=` is cached by the browser for a year.
  assert.match(SRC, /const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";/);
  assert.match(SRC, /if \(urlPath\.endsWith\("\.html"\)\) \{[\s\S]*?no-store/);
});

test("index.html and its preload reference the same app.js version", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const preload = /<link rel="preload" href="\/js\/app\.js\?v=(\d+)"/.exec(html);
  const script = /<script defer src="\/js\/app\.js\?v=(\d+)"><\/script>/.exec(html);
  assert.ok(preload && script, "app.js must be both preloaded and loaded");
  assert.equal(preload[1], script[1], "a mismatched version downloads app.js twice");
});
