"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../public/js/events.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const now = Date.now();
const payload = (platform = "telegram") => ({
  posts: [{ id: "1", title: "TEST token unlock schedule", text: "TEST token unlock schedule. <img src=x onerror=alert(1)>",
    project: "TEST", platform, topic: "unlock", publishedAt: now, url: "https://t.me/test/1", evidenceUrl: "https://test.org" }],
  sources: [{ project: "TEST", platform, status: platform === "x" ? "requires_api_token" : "ok", url: "https://t.me/test", evidenceUrl: "https://test.org", verifiedAt: now, lastSuccessAt: now }],
  coverage: { candidates: 1200, checked: 60, verifiedProjects: 50, reading: 8 }, platforms: {},
  updatedAt: now, page: 0, sourcePage: 0, postTotal: 1, sourceTotal: 1
});
function view(t, socialFetch) {
  const w = new JSDOM(html, { url: "http://localhost", runScripts: "outside-only" }).window;
  w.AbortSignal = AbortSignal; w.AbortController = AbortController;
  w.EventSource = class { addEventListener() {} close() {} };
  w.fetch = async url => String(url).startsWith("/api/events/social?") ? socialFetch(url) : ({ ok: true, json: async () => ({ news: [], listings: [], social: { updatedAt: now } }) });
  w.eval(script); w.ObsidianEvents.activate();
  t.after(() => { w.ObsidianEvents.stopAlerts(); w.close(); });
  return w;
}

test("official channels distinguish candidates from live coverage, show evidence and do not execute post HTML", async t => {
  const calls = [];
  const w = view(t, async url => { calls.push(url); return { ok: true, json: async () => payload() }; });
  await tick(); w.document.getElementById("events-tab-social").click(); await tick();
  assert.match(w.document.getElementById("events-social-coverage").textContent, /Кандидатов: 1200/);
  assert.match(w.document.getElementById("events-social-coverage").textContent, /за 10 минут: 8/);
  assert.match(w.document.getElementById("events-social-coverage").textContent, /X: нужен доступ/);
  assert.equal(w.document.querySelector("#events-social-list img"), null);
  assert.match(w.document.getElementById("events-social-list").textContent, /Автоматически в календарь не добавляется/);
  assert.equal(w.document.querySelector('#events-social-list a[href="https://test.org/"]')?.textContent, "Проверить источник ↗");
  w.document.querySelector('[data-social-topic="unlock"]').click(); await tick();
  assert.equal(new URL(calls.at(-1), "https://test.org").searchParams.get("topic"), "unlock");
  w.document.getElementById("events-tab-news").click();
  assert.equal(w.document.getElementById("events-social-panel").hidden, true);
});

test("a delayed previous filter cannot overwrite the latest selection and network failure keeps prior data", async t => {
  const pending = [];
  const w = view(t, url => new Promise(resolve => pending.push({ url, resolve })));
  await tick(); w.document.getElementById("events-tab-social").click();
  await tick(); w.document.querySelector('[data-social-platform="x"]').click(); await tick();
  assert.equal(pending.length, 2);
  pending[1].resolve({ ok: true, json: async () => payload("x") }); await tick();
  pending[0].resolve({ ok: true, json: async () => payload("telegram") }); await tick();
  assert.match(w.document.getElementById("events-social-list").textContent, /TEST · x/);
  assert.doesNotMatch(w.document.getElementById("events-social-list").textContent, /TEST · telegram/);
  w.document.querySelector('[data-social-platform="discord"]').click(); await tick();
  pending[2].resolve({ ok: false }); await tick();
  assert.match(w.document.getElementById("events-social-coverage").textContent, /Не удалось обновить/);
  assert.match(w.document.getElementById("events-social-list").textContent, /TEST · x/);
});
