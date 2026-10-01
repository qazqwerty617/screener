"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createPublicUnlocks, normalizeDrops, normalizeTokenomist, publicVestingList, readResponse } = require("../publicUnlocks");
const { createUnlockService } = require("../unlockService");
const { unlockSignals } = require("../unlockSignals");
const { publisher } = require("../newsVerification");
const now = Date.UTC(2026, 8, 27), DAY = 86400000;
const sale = { date: now + DAY, tokens: 1000, saleId: 5, sale: "Investors", unlockType: "CLIFF" };
const coin = { currencyId: 123, slug: "test-token", symbol: "TT", name: "Test Token", maxSupply: 100000,
  circulatingSupply: 50000, fundraisingBaseData: { nextUnlocksBySales: [sale] } };
const tokenKeys = ["tokenSlug", "tokenSymbol", "tokenName", "tokenReferenceMaxSupply", "tokenCirculatingSupply", "upcomingEvent"];
const list = { metadata: { total: 642 }, rows: [{ k: tokenKeys,
  r: [["test-token", "TT", "Test", 100000, 50000, { dateUnix: (now + DAY) / 1000, amount: 1200, precision: "Month" }]] }] };
function page(value = list) {
  const rsc = `9:${JSON.stringify(["$", "component", null, { initialVestingList: value }])}\n`;
  return `<script>self.__next_f.push(${JSON.stringify([1, rsc.slice(0, 45)])})</script><script>self.__next_f.push(${JSON.stringify([1, rsc.slice(45)])})</script>`;
}
function market(coins = [coin], number = 0, totalPages = 1) {
  return new Response(JSON.stringify({ markets: { content: coins, number, totalPages, totalElements: totalPages * coins.length } }));
}
test("public calendar keeps cliffs, linear tranches and allocations separate without double counting", () => {
  const c = { ...coin, fundraisingBaseData: { nextUnlocksBySales: [sale, sale,
    { ...sale, saleId: 6, tokens: 500, sale: "Team" }, { ...sale, unlockType: "LINEAR", tokens: 25 }] } };
  const rows = normalizeDrops([c, c], now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, 1500); assert.equal(rows[0].percentSupply, 1.5);
  assert.equal(rows[1].amount, 25); assert.equal(rows[1].unlockType, "linear");
  assert.equal(rows[0].allocations.length, 2); assert.equal(rows[0].confidence, "aggregated");
});
test("invalid amounts, dates, links and unrelated ticker identities do not become unlocks", () => {
  const rows = normalizeDrops([coin, { ...coin, currencyId: 124, slug: "other" }, { ...coin, slug: "../evil" },
    ...[NaN, Infinity, -1, true, "", 0].map(tokens => ({ ...coin, fundraisingBaseData: { nextUnlocksBySales: [{ ...sale, tokens }] } }))], now);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].assetId, rows[1].assetId);
  assert.equal(normalizeDrops([{ ...coin, fundraisingBaseData: { nextUnlocksBySales: [{ ...sale, date: now + 999 * DAY }] } }], now).length, 0);
});
test("public RSC parsing handles split chunks without executing scripts", () => {
  assert.deepEqual(publicVestingList(page()), list);
  assert.throws(() => publicVestingList('<script>self.__next_f.push(alert("x"))</script>'), /format changed/);
  assert.throws(() => publicVestingList('NEXT_REDIRECT /auth/signin'), /format changed/);
});
test("provider precision is preserved as a month/week window, not a fabricated exact date", () => {
  const monthly = normalizeTokenomist(list, now)[0];
  assert.equal(monthly.windowStart, Date.UTC(2026, 8, 1));
  assert.equal(monthly.windowEnd, Date.UTC(2026, 9, 1) - 1);
  assert.equal(monthly.unlockType, "unknown");
  const copy = structuredClone(list); copy.rows[0].r[0][5].precision = "Week";
  const weekly = normalizeTokenomist(copy, now)[0];
  assert.equal(weekly.windowStart, now - 2 * DAY); assert.equal(weekly.windowEnd, now + 5 * DAY - 1);
  copy.rows[0].r[0][5].precision = "To Be Determined";
  assert.deepEqual(normalizeTokenomist(copy, now), []);
});
test("column names, not a hardcoded column offset, define token identity and event", () => {
  const copy = structuredClone(list); copy.rows[0].k.reverse(); copy.rows[0].r[0].reverse();
  assert.deepEqual(normalizeTokenomist(copy, now), normalizeTokenomist(list, now));
});
test("free sources paginate all public projects, share concurrent polls and never call the paid API", async () => {
  let calls = 0;
  const service = createUnlockService({ apiKey: "", now: () => now, officialPlans:{refresh:async()=>{},snapshot:()=>({rows:[],source:null})},request: async (url, opts) => {
    calls++; assert.doesNotMatch(url, /pro-api/);
    if (url.includes("coinmarketcap")) return new Response("offline", { status: 503 });
    if (url.includes("tokenomist")) return new Response(page());
    const p = JSON.parse(opts.body); assert.deepEqual(p.filters, { vestingPeriod: true });
    return market([{ ...coin, currencyId: 123 + p.page }], p.page, 3);
  } });
  await Promise.all(Array.from({ length: 20 }, () => service.refresh()));
  assert.equal(calls, 5); await service.refresh(); assert.equal(calls, 5);
  const result = service.snapshot();
  assert.equal(result.sources.dropstab.scannedTokens, 3); assert.equal(result.sources.dropstab.tokens, 3);
  assert.equal(result.sources.dropstab.partial, false); assert.equal(result.sources.tokenomist.partial, true);
  assert.equal(result.coverage, "public_calendars"); assert.equal(result.sources.primary.tokens, require('../unlockSchedules').SCHEDULES.length);
});
test("outages retain bounded stale cache; expired data disappears; recovery clears the error", async () => {
  let time = now, fail = false;
  const service = createPublicUnlocks({ now: () => time, request: async url => fail ? new Response("offline", { status: 503 })
    : url.includes("tokenomist") ? new Response(page()) : market() });
  await service.refresh(); fail = true; time += 3600001; await service.refresh();
  let result = service.snapshot();
  assert.equal(result.rows.length, 2); assert.ok(result.rows.every(row => row.stale));
  assert.equal(result.sources.dropstab.status, "error");
  time += DAY; result = service.snapshot(); assert.equal(result.rows.length, 0);
  assert.equal(result.sources.dropstab.tokens, 0); assert.equal(result.sources.dropstab.expired, true);
  fail = false; await service.refresh(); assert.equal(service.snapshot().sources.dropstab.error, null);
});
test("a repeated page and malformed calendar are failures, never full-coverage successes", async () => {
  const service = createPublicUnlocks({ now: () => now, request: async (url, opts) => url.includes("tokenomist")
    ? new Response("page changed") : market([coin], JSON.parse(opts.body).page, 2) });
  await service.refresh(); const result = service.snapshot();
  assert.equal(result.rows.length, 0);
  assert.equal(result.sources.dropstab.error, "Calendar repeated a page");
  assert.equal(result.sources.tokenomist.status, "error");
});
test("one provider failing does not discard another provider's calendar", async () => {
  const service = createPublicUnlocks({ now: () => now, request: async url => url.includes("tokenomist")
    ? new Response("forbidden", { status: 403 }) : market() });
  await service.refresh(); assert.equal(service.snapshot().rows.length, 1);
  assert.equal(service.snapshot().sources.tokenomist.error, "HTTP 403");
});
test("a structurally valid empty calendar is distinct from an unavailable provider", async () => {
  const service=createPublicUnlocks({now:()=>now,request:async url=>url.includes("tokenomist")
    ?new Response(page({metadata:{total:0},rows:[]})):market([],0,0)});
  await service.refresh(); const result=service.snapshot();
  assert.equal(result.sources.dropstab.status,"empty");assert.equal(result.sources.tokenomist.status,"empty");
  assert.equal(result.rows.length,0);assert.equal(result.sources.dropstab.partial,false);
});
test("oversized streams are cancelled and not retained", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } });
  await assert.rejects(readResponse(new Response(body), 10), /too large/);
  assert.equal(cancelled, true);
});
test("HTTP errors release the response body instead of occupying a pooled connection", async()=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  await assert.rejects(readResponse(new Response(body,{status:429})),/HTTP 429/);
  assert.equal(cancelled,true);
});
test("unlock discovery keeps sourced articles as leads, never invented dates or amounts", () => {
  const row = { id: "1", title: "Token unlock schedule updated", url: "https://blog.sui.io/token-vesting", source: "Sui", originVerified: true, publishedAt: now };
  const rows = unlockSignals([row, row, { ...row, url: "https://evil.example", originVerified: true },
    { ...row, url: "https://blog.sui.io/potential", title: "Unlock the potential of gaming" },
    { ...row, url: "https://blog.sui.io/old", publishedAt: now - 8 * DAY }], now);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, "needs_schedule_review");
  assert.equal(rows[0].at, undefined); assert.equal(rows[0].amount, undefined);
});
test("Sui's canonical blog domain is authenticated without trusting lookalike hosts",()=>{
  assert.equal(publisher("https://www.sui.io/blog/token-vesting")[2],"Sui");
  assert.equal(publisher("https://blog.sui.io/token-vesting")[2],"Sui");
  assert.equal(publisher("https://sui.io.evil.example/blog/token-vesting"),null);
  assert.equal(publisher("https://www.sui.io/unrelated"),null);
});
