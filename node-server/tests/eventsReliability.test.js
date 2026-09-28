"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createEventsHub, createMarketFetcher, normalizeMarkets, parseGateAnnouncements, translateTitle } = require("../eventsHub");
const now = Date.now();
function hubFor(t, options) {
  const filePath = path.join(os.tmpdir(), `events-reliability-${crypto.randomUUID()}.json`);
  const hub = createEventsHub({ filePath, now: () => now, translate: async () => null,
    unlockService: { refresh: async () => {}, snapshot: () => ({ rows: [] }) }, ...options });
  t.after(() => { hub.stop(); try { fs.unlinkSync(filePath); } catch (_) {} });
  return hub;
}

test("a slow calendar does not stall news polls or emit duplicate completion updates", async t => {
  let finish, calls=0, version=0, updates=0;
  const hub=hubFor(t,{fetchFeed:async()=>"<rss/>",fetchGateAnnouncements:async()=>({code:0,data:{list:[]}}),
    unlockService:{refresh:()=>{calls++;return new Promise(resolve=>finish=()=>{version++;resolve();});},snapshot:()=>({sources:{test:{version}}})}});
  hub.subscribe(()=>updates++);
  await hub.refreshNews(); await hub.refreshNews();
  assert.equal(calls,1); assert.equal(updates,0);
  finish(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(updates,1); assert.equal(hub.snapshot().unlocks.sources.test.version,1);
});
test("a corroborated hack emits one toast; a later denial retracts it", t => {
  const hub = hubFor(t), events = [];
  hub.subscribe(event => { if (event) events.push(event); });
  const a = { title: "Bybit loses $80 million in Ethereum wallet exploit", url: "https://www.coindesk.com/markets/hack", publishedAt: now, originVerified: true };
  const b = { ...a, title: "Ethereum wallet exploit costs Bybit $80 million", url: "https://decrypt.co/123/hack" };
  hub.ingestNews([a]); assert.equal(hub.snapshot().news.length, 0);
  hub.ingestNews([b]); assert.equal(hub.snapshot().news.length, 1);
  assert.equal(events.filter(event => event.type === "urgent").length, 1);
  hub.ingestNews([{ ...b, title: "Bybit denies Ethereum wallet exploit", url: "https://decrypt.co/123/denial" }]);
  assert.equal(hub.snapshot().news.length, 0);
  assert.ok(events.some(event => event.type === "retract"));
});

test("a publisher's ordinary report reaches the news feed while an unconfirmed hack stays off it", t => {
  const hub = hubFor(t);
  hub.ingestNews([{ title: "Bitcoin ETF inflows rose on Monday", url: "https://www.coindesk.com/markets/etf-inflows",
    source: "CoinDesk", publishedAt: now, originVerified: true }]);
  assert.equal(hub.snapshot().news.length, 1);
  assert.equal(hub.snapshot().news[0].verification.status, "reported");
  hub.ingestNews([{ title: "Bybit loses $80 million in Ethereum wallet exploit", url: "https://www.coindesk.com/markets/hack",
    source: "CoinDesk", publishedAt: now, originVerified: true }]);
  assert.equal(hub.snapshot().news.length, 1);
});

test("a failed headline translation is retried when a feed repeats the article", async t => {
  let calls = 0;
  let clock = now;
  const hub = hubFor(t, { now: () => clock,
    translate: async () => ++calls === 1 ? null : "Приток средств в биткоин ETF вырос" });
  const article = { title: "Bitcoin ETF inflows rose on Monday", url: "https://www.coindesk.com/markets/etf-inflows",
    source: "CoinDesk", publishedAt: now, originVerified: true };
  hub.ingestNews([article]);
  await new Promise(resolve => setImmediate(resolve));
  clock += 60000;
  hub.ingestNews([article]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.snapshot().news[0].titleRu, "Приток средств в биткоин ETF вырос");
});

test("a fresh headline moves ahead of the old translation backlog", async t => {
  const started = [], pending = [];
  const hub = hubFor(t, { translate: title => {
    started.push(title);
    return new Promise(resolve => pending.push(resolve));
  } });
  const article = (id, age) => ({ title: `Market report number ${id} describes token activity`,
    url: `https://www.coindesk.com/markets/report-${id}`, source: "CoinDesk",
    publishedAt: now - age * 60000, originVerified: true });
  hub.ingestNews([article(1, 50), article(2, 40), article(3, 30), article(4, 20)]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 2);
  hub.ingestNews([article(5, 0)]);
  pending[0]("Рыночный отчёт об активности токенов");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started[2], article(5, 0).title);
});

test("translation quota exhaustion is reported and does not hammer the provider", async t => {
  let calls = 0;
  const hub = hubFor(t, { translate: async () => {
    calls++;
    const error = new Error("daily quota exhausted");
    error.retryAfterMs = 24 * 3600000;
    throw error;
  } });
  hub.ingestNews(Array.from({ length: 5 }, (_, i) => ({
    title: `Market report number ${i} describes token activity`,
    url: `https://www.coindesk.com/markets/report-${i}`, source: "CoinDesk",
    publishedAt: now - i * 60000, originVerified: true })));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls <= 2);
  assert.ok(hub.snapshot().translation.pausedUntil >= now + 24 * 3600000);
  assert.equal(hub.snapshot().translation.untranslated, 5);
});

test("MyMemory quota response is treated as failure rather than a translated headline", async () => {
  await assert.rejects(translateTitle("Bitcoin reached a new high", "", async () => ({ ok: true,
    json: async () => ({ responseStatus: 200, quotaFinished: true,
      responseData: { translatedText: "Биткоин достиг нового максимума" } }) })),
  error => error.retryAfterMs === 24 * 3600000);
});

test("a flood of unverified stream leads cannot evict a sourced article", t => {
  const hub = hubFor(t);
  hub.ingestNews([{ title: "Bitcoin ETF inflows rose on Monday", url: "https://www.coindesk.com/markets/etf-inflows",
    source: "CoinDesk", publishedAt: now - 30 * 60000, originVerified: true }]);
  hub.ingestNews(Array.from({ length: 260 }, (_, i) => ({
    title: `Unconfirmed report number ${i} about market activity`,
    url: `https://t.me/somechannel/${i}`, publishedAt: now - i * 1000, originVerified: false,
  })));
  assert.equal(hub.snapshot().news.length, 1);
  assert.equal(hub.snapshot().news[0].source, "CoinDesk");
});
test("revisions invalidate an old translated headline and canonical URLs deduplicate tracking links", t => {
  const hub = hubFor(t);
  const item = { title: "Bybit reports a security breach", titleRu: "Предыдущий перевод", url: "https://announcements.bybit.com/en/article/hack", publishedAt: now, originVerified: true };
  hub.ingestNews([item]);
  hub.ingestNews([{ ...item, title: "Bybit denies security breach", titleRu: undefined, url: `${item.url}?utm_source=tg` }]);
  assert.equal(hub.snapshot().news.length, 0);
});
test("KuCoin spot and futures clients are both loaded", async () => {
  const calls = [];
  const fetchMarkets = createMarketFetcher(id => ({ loadMarkets: async () => { calls.push(id); return { [id]: { symbol: id } }; } }));
  const rows = await fetchMarkets("kucoin");
  assert.deepEqual(calls.sort(), ["kucoin", "kucoinfutures"]);
  assert.equal(Object.keys(rows).length, 2);
  await fetchMarkets.close();
});

test("priority market refresh checks Gate, MEXC, Aster and Hyperliquid first without dropping full coverage", async t => {
  const calls = [];
  const hub = hubFor(t, { fetchMarkets: async id => {
    calls.push(id);
    return { btc: { symbol: "BTC/USDT", base: "BTC", quote: "USDT", spot: true } };
  } });
  await hub.refreshMarkets(["GT", "MX", "AD", "HL"]);
  assert.deepEqual(calls, ["gate", "mexc", "aster", "hyperliquid"]);
  await hub.refreshMarkets();
  assert.equal(Object.keys(hub.snapshot().venues).length, 11);
});

test("Gate official announcements are parsed from authenticated article paths and enter the news feed", async t => {
  const payload = { code: 0, data: { list: [
    { id: 1, title: "Gate will list BREW for spot trading", url: "/announcements/article/101862", release_timestamp: String(now / 1000) },
    { id: 2, title: "Gate will list FAKE", url: "https://gate.com.evil.example/article/2", release_timestamp: String(now / 1000) },
    { id: 3, title: "Gate VIP bonus campaign", url: "/announcements/article/101863", release_timestamp: String(now / 1000) },
  ] } };
  const rows = parseGateAnnouncements(payload, now);
  assert.deepEqual(rows.map(row => row.id), ["gate:1"]);
  const hub = hubFor(t, { fetchFeed: async () => "<rss/>", fetchGateAnnouncements: async () => payload });
  await hub.refreshNews();
  assert.equal(hub.snapshot().news[0].source, "Gate.io");
  assert.equal(hub.snapshot().news[0].verification.status, "official");
});

test("Gate Russian announcement text is attached to the matching official article", async t => {
  const english = { code: 0, data: { list: [{ id: 42, title: "Gate will list BREW for spot trading",
    url: "/announcements/article/42", release_timestamp: String(now / 1000) }] } };
  const russian = { code: 0, data: { list: [{ id: 42, title: "Gate добавит BREW для спотовой торговли" }] } };
  const hub = hubFor(t, { fetchFeed: async () => "<rss/>", fetchGateAnnouncements: async () => ({ english, russian }) });
  await hub.refreshNews();
  assert.equal(hub.snapshot().news[0].titleRu, "Gate добавит BREW для спотовой торговли");
  const oldHub = hubFor(t);
  oldHub.ingestNews(parseGateAnnouncements(english, now));
  oldHub.ingestNews(parseGateAnnouncements({ english, russian }, now));
  assert.equal(oldHub.snapshot().news[0].titleRu, "Gate добавит BREW для спотовой торговли");
});
test("a catalogue timeout does not start overlapping requests for the same exchange", async () => {
  let finish, calls = 0;
  const fetchMarkets = createMarketFetcher(() => ({ loadMarkets: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }), 10);
  await assert.rejects(fetchMarkets("gate"), /deadline/);
  const pending = fetchMarkets("gate");
  finish({ btc: {} }); await pending;
  assert.equal(calls, 1);
  await fetchMarkets.close();
});
test("a late successful catalogue is consumed once by the next scan", async () => {
  let finish, calls = 0;
  const fetchMarkets = createMarketFetcher(() => ({ loadMarkets: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }), 10);
  await assert.rejects(fetchMarkets("gate"), /deadline/);
  finish({ btc: { symbol: "BTC/USDT" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetchMarkets("gate")).btc.symbol, "BTC/USDT");
  assert.equal(calls, 1);
  await fetchMarkets.close();
});
test("future inactive markets and official perpetual delisting dates are retained; USDC stays excluded", () => {
  const market = { symbol: "NEW/USDT:USDT", base: "NEW", quote: "USDT", settle: "USDT", swap: true, active: false, info: { launchTime: now + 3600000 } };
  assert.equal(normalizeMarkets({ market }, "BB", now)[0].launchAt, now + 3600000);
  const removed = { ...market, active: true, info: { deliveryTime: now + 86400000 } };
  assert.equal(normalizeMarkets({ removed }, "BB", now)[0].delistAt, now + 86400000);
  assert.equal(normalizeMarkets({ market: { ...market, quote: "USDC" } }, "BB", now).length, 0);
  const spot = { ...market, spot: true, swap: false, info: { listTime: now + 3600000, contTdSwTime: now + 7200000 } };
  assert.equal(normalizeMarkets({ spot }, "OX", now)[0].launchAt, now + 7200000);
  const gateSpot = { ...spot, info: { delisting_time: Math.floor((now + 86400000) / 1000) } };
  assert.equal(normalizeMarkets({ gateSpot }, "GT", now)[0].delistAt, Math.floor((now + 86400000) / 1000) * 1000);
});
test("scheduled delistings retain exchange time and disappear when the exchange cancels the schedule", async t => {
  let end = now + 86400000;
  const hub = hubFor(t, { fetchMarkets: async id => ({ market: { symbol: "NEW/USDT:USDT", base: "NEW", quote: "USDT", settle: "USDT", swap: true,
    info: id === "bybit" && end !== undefined ? { deliveryTime: end } : {} } }) });
  await hub.refreshMarkets();
  const event = hub.snapshot().listings.find(row => row.kind === "delisting");
  assert.equal(event.exchange, "BB"); assert.equal(event.delistAt, end);
  await hub.refreshMarkets(); assert.equal(hub.snapshot().listings.filter(row => row.kind === "delisting").length, 1);
  end = undefined; await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.filter(row => row.kind === "delisting").length, 1, "an omitted field is not a cancellation");
  end = 0; await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.filter(row => row.kind === "delisting").length, 0);
});
test("a failed scan resets disappearance confirmation without forgetting the missing market", async t => {
  let present = true, offline = false;
  const hub = hubFor(t, { fetchMarkets: async id => {
    if (id === "binance" && offline) throw new Error("offline");
    return { ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, { symbol: `BASE${i}/USDT`, base: `BASE${i}`, quote: "USDT", spot: true }])),
      ...(present && id === "binance" ? { extra: { symbol: "NEW/USDT", base: "NEW", quote: "USDT", spot: true } } : {}) };
  } });
  await hub.refreshMarkets(); present = false;
  await hub.refreshMarkets(); await hub.refreshMarkets();
  offline = true; await hub.refreshMarkets(); offline = false;
  await hub.refreshMarkets(); await hub.refreshMarkets();
  assert.equal(hub.snapshot().listings.length, 0);
  await hub.refreshMarkets(); assert.equal(hub.snapshot().listings.length, 1);
});
