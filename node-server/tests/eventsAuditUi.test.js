"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../public/js/events.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, payload) {
  const dom = new JSDOM(html, { url: "https://obsidianscreener.com", runScripts: "outside-only" });
  const w = dom.window;
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
  const date = new Date(at), key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  if (!w.document.querySelector(`[data-unlock-date="${key}"]`)) click("events-unlocks-next-month");
  const cell = w.document.querySelector(`[data-unlock-date="${key}"]`);
  assert.ok(cell); assert.match(cell.textContent, /125/); assert.match(cell.textContent, /\+122/);
  cell.click();
  assert.equal(list.querySelectorAll("article").length, 100);
  assert.match(list.textContent, /Ещё 25 событий/);
  assert.match(list.textContent, /точное время неизвестно/);
  assert.equal(list.querySelectorAll('a[href^="javascript:"]').length, 0);
  const search = w.document.getElementById("events-unlocks-search");
  search.value = "XPL"; search.dispatchEvent(new w.Event("input"));
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
  const at = Date.now()+86400000;
  const base={name:"Test",amount:1000,sources:["https://dropstab.com/coins/test/vesting"],precision:"day",at};
  const rows=[{...base,symbol:"CLIFF",unlockType:"cliff",provider:"DropsTab"},
    {...base,symbol:"LINEAR",unlockType:"linear",provider:"DropsTab"},
    {...base,symbol:"PRIMARY",unlockType:"scheduled",provider:"Документация проекта",confidence:"schedule"},
    {...base,symbol:"MONTH",at:start,windowStart:start,windowEnd:end,precision:"month",unlockType:"unknown",provider:"Tokenomist"}];
  const {w,click}=await setup(t,{news:[],unlocks:{rows,signals:[{title:"Vesting schedule announcement",url:"https://blog.sui.io/vesting",source:"Sui",publishedAt:Date.now()}]}});
  click("events-tab-unlocks"); const list=w.document.getElementById("events-unlocks-list");
  assert.equal(w.document.querySelectorAll("#events-unlocks-calendar .events-calendar-day").length,new Date(date.getFullYear(),date.getMonth()+1,0).getDate());
  assert.ok(w.document.querySelector("#events-unlocks-calendar .unlock-entry.uncertain"));
  const tomorrow=new Date(at), tomorrowKey=`${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
  w.document.querySelector(`[data-unlock-date="${tomorrowKey}"]`).click();
  assert.equal(list.querySelectorAll("article").length,3);
  const pick=(kind,value)=>w.document.querySelector(`.events-picker[data-picker="unlock-${kind}"] [data-value="${value}"]`).click();
  pick("type","linear"); assert.equal(list.querySelectorAll("article").length,1); assert.match(list.textContent,/LINEAR/);
  pick("type","all"); pick("source","primary"); assert.match(list.textContent,/PRIMARY/); assert.doesNotMatch(list.textContent,/CLIFF/);
  pick("source","Tokenomist");
  w.document.querySelector(`[data-unlock-date="${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-01"]`).click();
  assert.match(list.textContent,/MONTH/); assert.match(list.textContent,/любой день месяца/);
  assert.match(w.document.getElementById("events-unlocks-signals").textContent,/расписание требует проверки/);
  assert.doesNotMatch(list.textContent,/Vesting schedule announcement/);
});

test("an hour-precision unlock displays the actual hour rather than an unspecified hour label", async t => {
  const at = Math.floor(Date.now() / 86400000) * 86400000 + 86400000 + 13 * 3600000;
  const { w, click } = await setup(t, { news: [], unlocks: { rows: [{ at, amount: 50, name: "Hourly", symbol: "HOUR",
    precision: "hour", provider: "Tokenomist", sources: [] }] } });
  click("events-tab-unlocks");
  const date = new Date(at), key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  if (!w.document.querySelector(`[data-unlock-date="${key}"]`)) click("events-unlocks-next-month");
  w.document.querySelector(`[data-unlock-date="${key}"]`).click();
  assert.match(w.document.getElementById("events-unlocks-list").textContent, /\d{1,2}:00/);
});
