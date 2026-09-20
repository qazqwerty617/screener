"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { VENUES, createEventsHub, parseNews, parseStreamNews } = require("../eventsHub");

test("all eleven exchanges establish a spot and futures baseline before recording new listings", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  let expanded = false;
  const hub = createEventsHub({ filePath, now: () => 1_800_000_000_000,
    fetchMarkets: async exchangeId => {
      const base = {
        [`${exchangeId}-spot`]: { symbol: "BTC/USDT", base: "BTC", spot: true, info: {} },
        [`${exchangeId}-swap`]: { symbol: "BTC/USDT:USDT", base: "BTC", swap: true, info: {} }
      };
      if (expanded) {
        base[`${exchangeId}-new-spot`] = { symbol: "NEW/USDT", base: "NEW", spot: true, info: {} };
        base[`${exchangeId}-new-swap`] = { symbol: "NEW/USDT:USDT", base: "NEW", swap: true, info: {} };
      }
      return base;
    } });
  await hub.refreshMarkets();
  assert.equal(Object.keys(hub.snapshot().venues).length, VENUES.length);
  assert.equal(hub.snapshot().listings.length, 0, "existing markets are not presented as fresh listings");
  expanded = true;
  await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.length, VENUES.length * 2);
  for (const [code] of VENUES) {
    assert.equal(hub.snapshot().listings.filter(row => row.exchange === code && row.type === "spot").length, 1);
    assert.equal(hub.snapshot().listings.filter(row => row.exchange === code && row.type === "futures").length, 1);
  }
});

test("published launch time is distinct from discovery and survives a feed outage", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  const now = 1_800_000_000_000;
  const hub = createEventsHub({ filePath, now: () => now,
    fetchMarkets: async exchangeId => exchangeId === "binance" ? {
      future: { symbol: "NEXT/USDT:USDT", base: "NEXT", swap: true, info: { onboardDate: now + 86400000 } }
    } : { current: { symbol: "BTC/USDT", base: "BTC", spot: true, info: {} } },
    fetchFeed: async () => { throw new Error("offline"); } });
  await hub.refreshMarkets();
  const listing = hub.snapshot().listings[0];
  assert.equal(listing.exchange, "BN");
  assert.equal(listing.launchAt, now + 86400000);
  assert.equal(listing.timing, "exchange");
  await hub.refreshNews();
  assert.equal(hub.snapshot().listings.length, 1);
});

test("urgent feed headlines retain their source and reject unsafe links", () => {
  const xml = `<rss><channel><item><title>Exchange hack &amp; security breach</title><link>https://example.com/report</link><pubDate>Tue, 09 Dec 2025 12:00:00 GMT</pubDate></item><item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Tue, 09 Dec 2025 12:00:00 GMT</pubDate></item></channel></rss>`;
  const rows = parseNews(xml, "Test source", Date.parse("2025-12-09T13:00:00Z"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priority, "urgent");
  assert.equal(rows[0].source, "Test source");
  assert.match(rows[0].title, /hack & security/);
});

test("stream headlines publish immediately, translate later, and survive RSS refresh", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  const time = Date.parse("2025-12-09T13:00:00Z");
  let finishTranslation;
  const hub = createEventsHub({ filePath, now: () => time,
    translate: () => new Promise(resolve => { finishTranslation = resolve; }),
    fetchFeed: async () => "<rss></rss>" });
  const notifications = [];
  hub.subscribe(() => notifications.push(hub.snapshot().news[0]?.titleRu));
  const item = parseStreamNews(JSON.stringify({ _id: "one", body: "Trump announces new tariff on crypto imports",
    source: "Reuters", link: "https://example.com/post", time }), time);
  assert.equal(item.priority, "urgent");
  hub.ingestNews([item]);
  assert.equal(hub.snapshot().news[0].title, item.title);
  assert.equal(hub.snapshot().news[0].titleRu, undefined);
  await hub.refreshNews();
  assert.equal(hub.snapshot().news.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  finishTranslation("Трамп объявил новые пошлины");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.snapshot().news[0].titleRu, "Трамп объявил новые пошлины");
  assert.equal(notifications.length, 2);
  hub.ingestNews([item]);
  assert.equal(hub.snapshot().news.length, 1);
});

test("stream rejects unsafe, stale and malformed posts", () => {
  const time = Date.parse("2025-12-09T13:00:00Z");
  const data = { body: "Exchange hacked and deposits suspended", source: "Wire", time };
  assert.equal(parseStreamNews(JSON.stringify({ ...data, link: "javascript:alert(1)" }), time), null);
  assert.equal(parseStreamNews(JSON.stringify({ ...data, link: "https://example.com", time: time - 8 * 86400000 }), time), null);
  assert.equal(parseStreamNews("garbage", time), null);
});
