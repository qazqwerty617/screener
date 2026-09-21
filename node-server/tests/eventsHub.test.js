"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { VENUES, createEventsHub, createMarketFetcher, parseNews, parseStreamNews, normalizeMarkets, alertKind } = require("../eventsHub");

test("only consequential headlines qualify for site-wide urgent cards", () => {
  assert.equal(alertKind("Major exchange suffers $80M hack"), "security");
  assert.equal(alertKind("Trump announces new tariff on crypto imports"), "macro");
  assert.equal(alertKind("Bitcoin liquidations rise after market volatility"), null);
  assert.equal(alertKind("Trump meme coin rises 4%"), null);
});

test("authenticated official critical news emits one alert, not another on translation or repeat", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  const now = Date.parse("2026-09-21T12:00:00Z");
  let resolveTranslation;
  const hub = createEventsHub({ filePath, now: () => now,
    translate: () => new Promise(resolve => { resolveTranslation = resolve; }) });
  const events = [];
  hub.subscribe(event => { if (event) events.push(event); });
  const item = { id: "hack", title: "Bybit reports a major hack", url: "https://announcements.bybit.com/en/article/hack",
    source: "Bybit", publishedAt: now - 1000, priority: "urgent", originVerified: true };
  hub.ingestNews([item]);
  assert.equal(events.filter(event => event.type === "urgent").length, 1);
  await new Promise(resolve => setImmediate(resolve));
  resolveTranslation("Биржу взломали");
  await new Promise(resolve => setImmediate(resolve));
  hub.ingestNews([item]);
  assert.equal(events.filter(event => event.type === "urgent").length, 1);
  assert.equal(events.find(event => event.type === "translation")?.item.titleRu, "Биржу взломали");
});

test("market clients are reused and force a fresh catalog after the first scan", async () => {
  const calls = [];
  let created = 0, closed = 0;
  const fetchMarkets = createMarketFetcher(() => {
    created++;
    return { async loadMarkets(reload) { calls.push(reload); return {}; }, async close() { closed++; } };
  });
  await fetchMarkets("binance"); await fetchMarkets("binance");
  assert.equal(created, 1);
  assert.deepEqual(calls, [false, true]);
  await fetchMarkets.close();
  assert.equal(closed, 1);
});

test("all venues scan with bounded parallelism", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  let active = 0, peak = 0;
  const releases = [];
  const hub = createEventsHub({ filePath, fetchMarkets: () => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    releases.push(() => { active--; resolve({ btc: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true } }); });
  }) });
  const scan = hub.refreshMarkets();
  assert.equal(active, 6, "six independent exchanges begin together");
  releases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 6);
  assert.equal(releases.length, 5);
  releases.splice(0).forEach(release => release());
  await scan;
  assert.equal(Object.keys(hub.snapshot().venues).length, VENUES.length);
});

test("a confirmed listing is published before an unrelated slow venue finishes", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  let expanded = false, block = false, releaseSlow;
  const hub = createEventsHub({ filePath, fetchMarkets: async id => {
    if (id === "aster" && block) await new Promise(resolve => { releaseSlow = resolve; });
    return { btc: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true },
      ...(id === "binance" && expanded ? { fresh: { symbol: "NEW/USDT", base: "NEW", quote: "USDT", spot: true } } : {}) };
  } });
  await hub.refreshMarkets(); expanded = true;
  await hub.refreshMarkets();
  let notify;
  const published = new Promise(resolve => { notify = resolve; });
  hub.subscribe(() => { if (hub.snapshot().listings.some(item => item.symbol === "NEW/USDT")) notify(); });
  block = true;
  const scan = hub.refreshMarkets();
  await published;
  assert.equal(typeof releaseSlow, "function", "slow venue remains in flight when listing is published");
  releaseSlow(); await scan;
});

test("listing catalog contains only active USDT spot and futures pairs", () => {
  const rows = normalizeMarkets({
    spot: { symbol: "AAA/USDT", base: "AAA", quote: "USDT", spot: true, active: true },
    future: { symbol: "AAA/USDT:USDT", base: "AAA", quote: "USDT", settle: "USDT", swap: true, active: true },
    usdc: { symbol: "BBB/USDC", base: "BBB", quote: "USDC", spot: true, active: true },
    inverse: { symbol: "CCC/USD:CCC", base: "CCC", quote: "USD", settle: "CCC", swap: true, active: true },
    inactive: { symbol: "DDD/USDT", base: "DDD", quote: "USDT", spot: true, active: false }
  }, "BN");
  assert.deepEqual(rows.map(row => row.symbol), ["AAA/USDT", "AAA/USDT:USDT"]);
});

test("brief loss of spot catalog does not create fake spot listings on recovery", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  const futures = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`f${i}`,
    { symbol: `F${i}/USDT:USDT`, base: `F${i}`, quote: "USDT", settle: "USDT", swap: true }]));
  const spot = { s1: { symbol: "S1/USDT", base: "S1", quote: "USDT", spot: true },
    s2: { symbol: "S2/USDT", base: "S2", quote: "USDT", spot: true } };
  let cycle = 0;
  const hub = createEventsHub({ filePath, now: () => 1_800_000_000_000,
    fetchMarkets: async exchange => exchange === "binance" ? { ...futures, ...(cycle === 1 ? {} : spot) }
      : { current: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true } } });
  await hub.refreshMarkets(); cycle = 1;
  await hub.refreshMarkets(); cycle = 2;
  await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.filter(item => item.exchange === "BN").length, 0);
  assert.equal(hub.snapshot().venues.BN.spot, 2);
});

test("first appearance of an entire spot catalog is a baseline, not hundreds of listings", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  let hasSpot = false;
  const hub = createEventsHub({ filePath, now: () => 1_800_000_000_000,
    fetchMarkets: async () => ({
      future: { symbol: "BTC/USDT:USDT", base: "BTC", quote: "USDT", settle: "USDT", swap: true },
      ...(hasSpot ? { spot: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true } } : {})
    }) });
  await hub.refreshMarkets(); hasSpot = true;
  await hub.refreshMarkets(); await hub.refreshMarkets();
  assert.equal(hub.snapshot().venues.BN.spot, 1);
  assert.equal(hub.snapshot().listings.length, 0);
});

test("bulk Bitget openTime is not treated as a listing date", () => {
  const now = 1_800_000_000_000;
  const [row] = normalizeMarkets({ spot: { symbol: "AAA/USDT", base: "AAA", quote: "USDT",
    spot: true, info: { openTime: now + 86400000 } } }, "BG", now);
  assert.equal(row.launchAt, null);
});

test("legacy non-USDT listing history is discarded while news is retained", t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  fs.writeFileSync(filePath, JSON.stringify({ known: { BN: ["BN:spot:OLD/USDC"] },
    listings: [{ id: "BN:spot:OLD/USDC", symbol: "OLD/USDC" }],
    news: [{ title: "Kept news", url: "https://example.com" }] }));
  const hub = createEventsHub({ filePath });
  assert.equal(hub.snapshot().listings.length, 0);
  assert.equal(hub.snapshot().news.length, 0, "legacy unverified headlines are withheld");
});

test("persistent market removal is an observed delisting, and a recovered pair retracts it", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  let present = true;
  let tick = Date.parse("2026-09-21T12:00:00Z");
  const hub = createEventsHub({ filePath, now: () => tick,
    fetchMarkets: async id => ({
      ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`base${i}`,
        { symbol: `B${i}/USDT`, base: `B${i}`, quote: "USDT", spot: true }])),
      future: { symbol: "BTC/USDT:USDT", base: "BTC", quote: "USDT", settle: "USDT", swap: true },
      ...(id === "binance" && present ? { extra: { symbol: "NEW/USDT", base: "NEW", quote: "USDT", spot: true } } : {})
    }) });
  await hub.refreshMarkets(); present = false;
  for (let n = 0; n < 2; n++) { tick += 300000; await hub.refreshMarkets(); }
  assert.equal(hub.snapshot().listings.length, 0, "a short gap is not a delisting");
  tick += 300000; await hub.refreshMarkets();
  const [event] = hub.snapshot().listings;
  assert.equal(event.kind, "delisting");
  assert.equal(event.symbol, "NEW/USDT");
  assert.equal(event.launchAt, null, "catalog removal has no claimed official delisting time");
  present = true; tick += 300000; await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.length, 0, "catalog recovery retracts the observation");
});

test("trusted exchange launch dates seed limited history without inventing events for other venues", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  const now = Date.parse("2026-09-21T12:00:00Z");
  const date = now - 2 * 86400000;
  const hub = createEventsHub({ filePath, now: () => now,
    fetchMarkets: async id => ({ current: { symbol: "NEW/USDT:USDT", base: "NEW", quote: "USDT",
      settle: "USDT", swap: true, info: id === "binance" ? { onboardDate: date } : { openTime: date } } }) });
  await hub.refreshMarkets();
  const events = hub.snapshot().listings;
  assert.equal(events.length, 1);
  assert.equal(events[0].exchange, "BN");
  assert.equal(events[0].historical, true);
  await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.length, 1);
});

test("an existing version-two catalog receives its dated history once", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  const now = Date.parse("2026-09-21T12:00:00Z");
  fs.writeFileSync(filePath, JSON.stringify({ marketVersion: 2, known: { BN: ["BN:spot:NEW/USDT"] },
    venues: { BN: { status: "ok", spot: 1, futures: 0 } }, listings: [] }));
  const hub = createEventsHub({ filePath, now: () => now,
    fetchMarkets: async () => ({ spot: { symbol: "NEW/USDT", base: "NEW", quote: "USDT", spot: true,
      info: { listTime: now - 86400000, onboardDate: now - 86400000 } } }) });
  await hub.refreshMarkets(); await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.filter(item => item.exchange === "BN").length, 1);
});

test("all eleven exchanges establish a spot and futures baseline before recording new listings", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  let expanded = false;
  const hub = createEventsHub({ filePath, now: () => 1_800_000_000_000,
    fetchMarkets: async exchangeId => {
      const base = {
        [`${exchangeId}-spot`]: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true, info: {} },
        [`${exchangeId}-swap`]: { symbol: "BTC/USDT:USDT", base: "BTC", quote: "USDT", settle: "USDT", swap: true, info: {} }
      };
      if (expanded) {
        base[`${exchangeId}-new-spot`] = { symbol: "NEW/USDT", base: "NEW", quote: "USDT", spot: true, info: {} };
        base[`${exchangeId}-new-swap`] = { symbol: "NEW/USDT:USDT", base: "NEW", quote: "USDT", settle: "USDT", swap: true, info: {} };
      }
      return base;
    } });
  await hub.refreshMarkets();
  assert.equal(Object.keys(hub.snapshot().venues).length, VENUES.length);
  assert.equal(hub.snapshot().listings.length, 0, "existing markets are not presented as fresh listings");
  expanded = true;
  await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.length, 0, "a single sighting is provisional");
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
  let expanded = false;
  const hub = createEventsHub({ filePath, now: () => now,
    fetchMarkets: async exchangeId => exchangeId === "binance" ? {
      current: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true, info: {} },
      currentFuture: { symbol: "BTC/USDT:USDT", base: "BTC", quote: "USDT", settle: "USDT", swap: true, info: {} },
      ...(expanded ? { future: { symbol: "NEXT/USDT:USDT", base: "NEXT", quote: "USDT", settle: "USDT", swap: true, info: { onboardDate: now + 86400000 } } } : {})
    } : { current: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true, info: {} } },
    fetchFeed: async () => { throw new Error("offline"); } });
  await hub.refreshMarkets(); expanded = true;
  await hub.refreshMarkets();
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

test("stream headlines wait for authenticated evidence before publishing or translating", async t => {
  const filePath = path.join(os.tmpdir(), `obsidian-events-${crypto.randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch (_) {} });
  const time = Date.parse("2025-12-09T13:00:00Z");
  let finishTranslation;
  const hub = createEventsHub({ filePath, now: () => time,
    translate: () => new Promise(resolve => { finishTranslation = resolve; }),
    fetchFeed: async () => "<rss></rss>" });
  const notifications = [];
  hub.subscribe(event => { if (event?.type !== "urgent") notifications.push(hub.snapshot().news[0]?.titleRu); });
  const item = parseStreamNews(JSON.stringify({ _id: "one", body: "Trump announces new tariff on crypto imports",
    source: "Reuters", link: "https://www.whitehouse.gov/presidential-actions/2025/12/tariffs/", time }), time);
  assert.equal(item.priority, "urgent");
  hub.ingestNews([item]);
  assert.equal(hub.snapshot().news.length, 0);
  await hub.refreshNews();
  assert.equal(hub.snapshot().news.length, 0);
  assert.equal(finishTranslation, undefined);
  hub.ingestNews([{ ...item, source: "White House", originVerified: true }]);
  assert.equal(hub.snapshot().news.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  finishTranslation("Трамп объявил новые пошлины");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.snapshot().news[0].titleRu, "Трамп объявил новые пошлины");
  assert.equal(notifications.length, 3);
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
