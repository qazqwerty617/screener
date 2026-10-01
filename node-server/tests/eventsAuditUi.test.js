"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../public/js/events.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, payload, fixedNow) {
  const dom = new JSDOM(html, { url: "https://obsidianscreener.com", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  if (fixedNow != null) {
    const RealDate = w.Date;
    w.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixedNow])); } static now() { return fixedNow; } };
  }
  const streams = [];
  w.EventSource = class {
    constructor() { streams.push(this); this.callbacks = {}; }
    addEventListener(name, fn) { this.callbacks[name] = fn; }
    close() { this.closed = true; }
  };
  w.fetch = async () => ({ ok: true, json: async () => payload });
  w.eval(script);
  t.after(() => { w.ObsidianEvents.stopAlerts(); w.close(); });
  w.document.getElementById("events-view").style.display = "block";
  w.ObsidianEvents.activate(); await tick();
  return { w, streams, click: id => w.document.getElementById(id).click() };
}
test("unlock calendar groups a large day, retains provenance, and omits unsafe links", async t => {
  const at = Math.floor(Date.now() / 86400000) * 86400000 + 86400000;
  const rows = Array.from({ length: 125 }, (_, i) => ({ id: String(i), symbol: i ? `TOKEN${i}` : "XPL", name: "Token", at,
    amount: 1000, precision: "day", provider: "Primary", sources: ["https://www.plasma.org/", "javascript:alert(1)"] }));
  const { w, click } = await setup(t, { news: [], unlocks: { rows, coverage: "primary_only", sources: { primary: { tokens: 3, reviewedAt: at } } } });
  click("events-tab-unlocks");
  const list = w.document.getElementById("events-unlocks-list");
  const key = new Date(at).toISOString().slice(0, 10);
  if (!w.document.querySelector(`[data-unlock-date="${key}"]`)) click("events-unlocks-next-month");
  const cell = w.document.querySelector(`[data-unlock-date="${key}"]`);
  assert.ok(cell); assert.match(cell.textContent, /125/); assert.match(cell.textContent, /\+122/);
  cell.click();
  assert.equal(list.querySelectorAll("article").length, 100);
  assert.match(list.textContent, /1–100 из 125/);
  list.querySelector(".unlock-pagination button:last-child").click();
  assert.equal(list.querySelectorAll("article").length, 25);
  assert.match(list.textContent, /101–125 из 125/);
  list.querySelector(".unlock-pagination button:first-child").click();
  assert.equal(list.querySelectorAll("article").length, 100);
  assert.match(list.textContent, /точное время неизвестно/);
  assert.equal(list.querySelectorAll('a[href^="javascript:"]').length, 0);
  const search = w.document.getElementById("events-unlocks-search");
  search.value = "XPL"; search.dispatchEvent(new w.Event("input"));
  await new Promise(resolve => w.requestAnimationFrame(resolve));
  assert.equal(list.querySelectorAll("article").length, 1);
  assert.match(w.document.getElementById("events-unlocks-status").textContent, /Охват ограничен/);
  assert.equal(w.document.getElementById("events-news-panel").hidden, true);
});
test("developing reports remain searchable but cannot raise confirmed toasts", async t => {
  const item = { title: "Bitget wallet exploit", source: "CoinDesk", alertKind: "security", url: "https://www.coindesk.com/markets/test",
    publishedAt: Date.now(), verification: { status: "pending", sources: [] } };
  const { w, streams } = await setup(t, { news: [], developing: [item] });
  assert.equal(w.document.getElementById("events-announcements-list"), null, "listings do not have announcements block");
  assert.match(w.document.getElementById("events-developing-list").textContent, /Bitget/);
  assert.ok(w.document.querySelector("#events-developing-list h3 .events-source-link"), "developing card uses h3 heading");
  assert.ok(w.document.querySelector("#events-developing-list .events-news-sources"), "developing card has news sources footer");
  streams[0].callbacks.urgent({ data: JSON.stringify(item) });
  assert.equal(w.document.querySelectorAll(".toast-urgent-news").length, 0);
  const search = w.document.getElementById("events-news-search");
  search.value = "Solana"; search.dispatchEvent(new w.Event("input"));
  await new Promise(resolve => w.requestAnimationFrame(resolve));
  assert.doesNotMatch(w.document.getElementById("events-developing-list").textContent, /Bitget/);
});
test("a failed refresh preserves last data and the offline label across tab changes", async t => {
  const { w, streams, click } = await setup(t, { newsUpdatedAt: Date.now(), news: [] });
  w.fetch = async () => { throw new Error("offline"); };
  streams[0].callbacks.open(); await tick();
  assert.match(w.document.getElementById("events-updated").textContent, /Нет связи/);
  click("events-tab-unlocks");
  assert.match(w.document.getElementById("events-updated").textContent, /Нет связи/);
});

test("unlock source and type menus preserve uncertain date windows and separate discovery leads", async t => {
  const date = new Date(), start = Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1), end=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)-1;
  const at = start + 15 * 86400000;
  const base={name:"Test",amount:1000,sources:["https://dropstab.com/coins/test/vesting"],precision:"day",at};
  const rows=[{...base,symbol:"CLIFF",unlockType:"cliff",provider:"DropsTab"},
    {...base,symbol:"LINEAR",unlockType:"linear",provider:"DropsTab"},
    {...base,symbol:"PRIMARY",unlockType:"scheduled",provider:"Документация проекта",confidence:"schedule"},
    {...base,symbol:"MONTH",at:start,windowStart:start,windowEnd:end,precision:"month",unlockType:"unknown",provider:"Tokenomist"}];
  const {w,click}=await setup(t,{news:[],unlocks:{rows,signals:[{title:"Vesting schedule announcement",url:"https://blog.sui.io/vesting",source:"Sui",publishedAt:Date.now()}]}});
  click("events-tab-unlocks"); const list=w.document.getElementById("events-unlocks-list");
  assert.equal(w.document.querySelectorAll("#events-unlocks-calendar .events-calendar-day").length,new Date(date.getFullYear(),date.getMonth()+1,0).getDate());
  assert.equal(w.document.querySelector("#events-unlocks-calendar .unlock-entry.uncertain"), null);
  assert.match(w.document.getElementById("events-unlocks-windows").textContent, /MONTH/);
  const tomorrowKey=new Date(at).toISOString().slice(0,10);
  w.document.querySelector(`[data-unlock-date="${tomorrowKey}"]`).click();
  assert.equal(list.querySelectorAll("article").length,3);
  const pick=(kind,value)=>w.document.querySelector(`.events-picker[data-picker="unlock-${kind}"] [data-value="${value}"]`).click();
  pick("type","linear"); assert.equal(list.querySelectorAll("article").length,1); assert.match(list.textContent,/LINEAR/);
  pick("type","all"); pick("source","primary"); assert.match(list.textContent,/PRIMARY/); assert.doesNotMatch(list.textContent,/CLIFF/);
  pick("source","Tokenomist");
  w.document.querySelector(`[data-unlock-date="${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-01"]`).click();
  assert.doesNotMatch(list.textContent,/MONTH/);
  assert.match(w.document.getElementById("events-unlocks-windows").textContent,/любой день месяца/);
  assert.match(w.document.getElementById("events-unlocks-signals").textContent,/расписание требует проверки/);
  assert.doesNotMatch(list.textContent,/Vesting schedule announcement/);
});

test("an hour-precision unlock displays the actual hour rather than an unspecified hour label", async t => {
  const at = Math.floor(Date.now() / 86400000) * 86400000 + 86400000 + 13 * 3600000;
  const { w, click } = await setup(t, { news: [], unlocks: { rows: [{ at, amount: 50, name: "Hourly", symbol: "HOUR",
    precision: "hour", provider: "Tokenomist", sources: [] }] } });
  click("events-tab-unlocks");
  const key = new Date(at).toISOString().slice(0, 10);
  if (!w.document.querySelector(`[data-unlock-date="${key}"]`)) click("events-unlocks-next-month");
  w.document.querySelector(`[data-unlock-date="${key}"]`).click();
  assert.match(w.document.getElementById("events-unlocks-list").textContent, /\d{1,2}:00/);
});

test("weekly windows intersect both months without masquerading as exact days; UTC month boundaries stay consistent", async t => {
  const at = Date.UTC(2026, 9, 1), week = { id: "week", symbol: "WEEK", name: "Window", at: at - 86400000, amount: 100,
    precision: "week", windowStart: at - 4 * 86400000, windowEnd: at + 3 * 86400000 - 1, provider: "Tokenomist" };
  const exact = { id: "exact", symbol: "EXACT", name: "Exact", at, amount: 100, precision: "time", provider: "CoinMarketCap", marketStatus: "inactive" };
  const { w, click } = await setup(t, { news: [], unlocks: { rows: [week, exact] } }, at + 60000);
  click("events-tab-unlocks");
  const list = w.document.getElementById("events-unlocks-list"), windows = w.document.getElementById("events-unlocks-windows");
  assert.match(list.textContent, /EXACT/); assert.match(list.textContent, /01.10.2026, 00:00:00 UTC/);
  assert.match(list.textContent, /неактивным/); assert.match(windows.textContent, /WEEK/);
  assert.doesNotMatch(w.document.getElementById("events-unlocks-calendar").textContent, /WEEK/);
  click("events-unlocks-prev-month"); assert.match(windows.textContent, /WEEK/);
  click("events-unlocks-next-month"); assert.match(list.textContent, /EXACT/);
  w.document.querySelector('.events-picker[data-picker="unlock-source"] [data-value="CoinMarketCap"]').click();
  assert.equal(w.document.getElementById("events-unlocks-windows-section").hidden, true);
  assert.match(list.textContent, /EXACT/);
  click("events-unlocks-hide-inactive"); assert.doesNotMatch(list.textContent, /EXACT/);
  click("events-unlocks-hide-inactive"); assert.match(list.textContent, /EXACT/);
});
