"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SITE_ORIGIN, PAGES, renderSeoPage, renderNotFoundPage, renderSitemap } = require("../seoPages");
const { INDEXNOW_KEY, createIndexNowPayload, submitIndexNow } = require("../submitIndexNow");

test("Google Search Console verification file remains publicly deployable", () => {
  const verification = fs
    .readFileSync(path.join(__dirname, "../public/google7a6742ba1122d8b6.html"), "utf8")
    .trim();

  assert.equal(verification, "google-site-verification: google7a6742ba1122d8b6.html");
});

test("every SEO landing page has unique crawlable metadata and visible content", () => {
  assert.ok(PAGES.length >= 6);
  const titles = new Set();
  const descriptions = new Set();
  for (const page of PAGES) {
    const html = renderSeoPage(page.path);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${SITE_ORIGIN}${page.path}">`));
    assert.match(html, /<meta name="robots" content="index,follow/);
    assert.match(html, /<script type="application\/ld\+json">/);
    assert.match(html, /<h1>[^<]{20,}<\/h1>/);
    assert.ok((html.match(/<h2>/g) || []).length >= 6);
    assert.ok(html.length > 5000, `${page.path} needs enough useful server-rendered copy`);
    const structuredData = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
    assert.doesNotThrow(() => JSON.parse(structuredData), `${page.path} needs valid JSON-LD`);
    assert.equal(titles.has(page.title), false, `duplicate title: ${page.title}`);
    assert.equal(descriptions.has(page.description), false, `duplicate description: ${page.description}`);
    titles.add(page.title);
    descriptions.add(page.description);
  }
});

test("sitemap contains only canonical public pages", () => {
  const xml = renderSitemap();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<url>/g) || []).length, PAGES.length + 1);
  for (const page of PAGES) assert.match(xml, new RegExp(`<loc>${SITE_ORIGIN}${page.path}<\\/loc>`));
  assert.doesNotMatch(xml, /\/api\//);
  assert.doesNotMatch(xml, /\/admin/);
});

test("robots advertises the canonical sitemap and blocks private surfaces", () => {
  const robots = fs.readFileSync(path.join(__dirname, "../public/robots.txt"), "utf8");
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Disallow: \/admin\//);
  assert.match(robots, new RegExp(`Sitemap: ${SITE_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/sitemap\\.xml`));
});

test("unknown pages render a real noindex 404 document", () => {
  const html = renderNotFoundPage();
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<h1>Страница не найдена<\/h1>/);
});

test("server exposes SEO pages before static assets and returns a 404 for unknown URLs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const seoRoute = source.indexOf('app.get(PAGES.map(page => page.path)');
  const staticRoute = source.indexOf("app.use(express.static");
  assert.ok(seoRoute >= 0 && seoRoute < staticRoute);
  assert.match(source, /app\.get\("\/sitemap\.xml"/);
  assert.match(source, /res\.status\(404\)\.send\(renderNotFoundPage\(\)\)/);
});

test("IndexNow payload publishes every canonical URL with a hosted ownership key", async () => {
  const payload = createIndexNowPayload();
  assert.equal(payload.host, "obsidianscreener.com");
  assert.equal(payload.key, INDEXNOW_KEY);
  assert.equal(payload.keyLocation, `${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`);
  assert.equal(payload.urlList.length, PAGES.length + 1);
  assert.ok(payload.urlList.every(url => url.startsWith(`${SITE_ORIGIN}/`)));

  let request;
  const status = await submitIndexNow(async (url, options) => {
    request = { url, options };
    return { status: 202 };
  });
  assert.equal(status, 202);
  assert.equal(request.url, "https://api.indexnow.org/indexnow");
  assert.deepEqual(JSON.parse(request.options.body), payload);
});
