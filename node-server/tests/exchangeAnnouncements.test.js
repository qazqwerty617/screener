"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { parseAnnouncements, listingAnnouncements } = require("../exchangeAnnouncements");
const { createEventsHub, parseNews, alertKind } = require("../eventsHub");
const now = Date.now();

test("Atom feeds preserve authenticated source and select article rather than self link", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Bitcoin ETF inflows increase</title>
    <link rel="self" href="https://blockworks.com/feed/1"/><link rel="alternate" href="https://blockworks.com/news/bitcoin-etf"/>
    <published>${new Date(now).toISOString()}</published></entry></feed>`;
  const rows = parseNews(xml, "Blockworks", now);
  assert.equal(rows.length, 1); assert.equal(rows[0].originVerified, true);
  assert.equal(rows[0].url, "https://blockworks.com/news/bitcoin-etf");
  assert.throws(() => parseNews("<html>Service unavailable</html>", "Blockworks", now));
  assert.equal(alertKind("Hack VC invests in a crypto startup"), null);
  assert.equal(alertKind("Hackers drain crypto wallets"), "security");
});
test("Bybit uses publication time rather than campaign launch time and rejects impostor URLs", () => {
  const row = { title: "Bybit will list NEW", publishTime: now, dateTimestamp: now - 20 * 86400000,
    url: "https://announcements.bybit.com/en-US/article/new-listing" };
  const rows = parseAnnouncements({ retCode: 0, result: { list: [row, { ...row, url: "https://bybit.com.evil.example/article/1" }] } }, "Bybit", now);
  assert.equal(rows.length, 1); assert.equal(rows[0].publishedAt, now);
  assert.equal(listingAnnouncements(rows).length, 1);
  assert.equal(listingAnnouncements(rows)[0].launchAt, undefined);
});
test("Bitget security notices have authenticated official source identity", () => {
  const rows = parseAnnouncements({ code: "00000", data: [{ annTitle: "Bitget reports a security incident", cTime: String(now),
    annUrl: "https://www.bitget.com/support/articles/1234" }] }, "Bitget", now);
  assert.equal(rows.length, 1); assert.equal(rows[0].originVerified, true);
});
test("Binance CMS announcements reject malformed codes and old dates", () => {
  const article = { title: "Binance will list NEW", releaseDate: now, code: "a".repeat(32) };
  const rows = parseAnnouncements({ code: "000000", data: { catalogs: [{ articles: [article,
    { ...article, code: "../square/1" }, { ...article, releaseDate: now - 8 * 86400000 }] }] } }, "Binance", now);
  assert.equal(rows.length, 1);
  assert.match(rows[0].url, /support\/announcement/);
});
test("a sourced unconfirmed hack remains discoverable without an urgent notification", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-audit-"));
  const filePath = path.join(dir, "events.json");
  const hub = createEventsHub({ filePath, translate: async () => null });
  t.after(async () => { hub.stop(); await hub.flush(); fs.rmSync(dir, { recursive: true }); });
  const alerts = []; hub.subscribe(event => { if (event?.type === "urgent") alerts.push(event); });
  hub.ingestNews([{ title: "Bitget suffers Ethereum wallet exploit", url: "https://www.coindesk.com/markets/incident",
    publishedAt: now, originVerified: true }]);
  assert.equal(hub.snapshot().news.length, 0);
  assert.equal(hub.snapshot().developing.length, 1);
  assert.equal(alerts.length, 0);
  await hub.flush();
  assert.equal(JSON.parse(fs.readFileSync(filePath)).news.length, 1);
});

test("persisted news is reassessed when security classification changes", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-migrate-"));
  const filePath = path.join(dir, "events.json");
  fs.writeFileSync(filePath, JSON.stringify({ news: [{ title: "Bitget hacker moves stolen XRP", url: "https://www.coindesk.com/markets/incident",
    publishedAt: now, originVerified: true, priority: "urgent", alertKind: null, verification: { status: "reported", sources: [] } }] }));
  const hub = createEventsHub({ filePath, translate: async () => null });
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true }); });
  assert.equal(hub.snapshot().news.length, 0);
  assert.equal(hub.snapshot().developing.length, 1);
});
