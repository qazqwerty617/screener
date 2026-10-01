"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { SEEDS, socialLink, catalogProjects, discoverAccounts } = require("../socialRegistry");
const { isPublicAddress, readSocialUrl } = require("../socialHttp");
const { topicOf, telegramPage, xPage, discordPage, websitePage } = require("../socialPosts");
const { createOfficialSocialService, discordConfig } = require("../officialSocialService");
const now = Date.now();
const project = { id: "test", name: "Test Network", symbol: "TEST", twitter: "testnetwork", website: "https://testnetwork.org/" };
const website = '<html><footer><a href="https://x.com/testnetwork">X</a><a href="https://t.me/testnetwork">Telegram</a></footer></html>';
const source = { ...project, projectId: project.id, project: project.name, platform: "telegram", account: "testnetwork", id: "test:telegram:testnetwork", evidenceUrl: project.website, verifiedAt: now };
const message = (id, text = "TEST token unlock schedule confirmed for October", extras = "") => `<div class="tgme_widget_message" data-post="testnetwork/${id}">${extras}<div class="tgme_widget_message_text">${text}</div><time datetime="${new Date(now).toISOString()}"></time></div>`;
const preview = (ids, next, text) => `<div class="tgme_channel_history">${ids.map(id => message(id, text)).join("")}${next ? `<a class="tme_messages_more" data-before="${next}">More</a>` : ""}</div>`;
function serviceFor(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "official-social-"));
  const opts = { filePath: path.join(dir, "state.json"), catalog: false, seeds: [project], now: () => now, xToken: "", discordToken: "", ...options };
  const service = createOfficialSocialService(opts);
  t.after(async () => { service.stop(); await service.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, opts };
}

test("catalog is not capped at 33 projects; duplicate accounts are deduplicated and unverified", () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `Project ${i}`, url: `https://project${i}.org`, twitter: `project${i}`, symbol: "SAME" }));
  const projects = catalogProjects([...rows, rows[0], { id: 2000, url: "http://127.0.0.1", twitter: "bad" }]);
  assert.equal(projects.length, 1200);
  assert.equal(projects[0].verifiedAt, undefined);
  assert.ok(SEEDS.some(p => p.symbol === "XPL"));
});

test("registry requires actual website links and excludes shares, lookalikes, unrelated accounts and body comments", () => {
  const html = `${website}<a href="https://x.com/partner">Partner</a><a href="https://t.me/imposter">comment</a><footer><a href="https://t.me/share?url=x">Share</a><a href="https://x.com.evil.org/testnetwork">Fake</a></footer><script>"https://t.me/fakechannel"</script>`;
  const found = discoverAccounts(html, project, now);
  assert.deepEqual(found.map(p => p.platform).sort(), ["telegram", "x"]);
  assert.ok(found.every(p => p.evidenceUrl === project.website && p.verifiedAt === now));
  assert.equal(socialLink("https://attacker@x.com/testnetwork"), null);
  assert.equal(socialLink("https://x.com/testnetwork/status/123"), null);
  assert.equal(socialLink("https://t.me/+privateinvite"), null);
  assert.equal(socialLink("https://discord.gg/InviteCode").account, "InviteCode");
});

test("source transport blocks local, mapped, reserved and metadata IPs", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  await assert.rejects(readSocialUrl("https://127.0.0.1/private"));
  await assert.rejects(readSocialUrl("http://localhost/private"));
});

test("noise filter retains market events and removes promotions that borrow unlock/listing words", () => {
  for (const text of ["Unlock your potential with our wallet", "New listing giveaway: retweet to win", "Trading competition and token unlock prize pool", "Доброе утро!", "Join our community AMA", "Token Name: PNXELPLAY. Presale Rate: 1 SOL = 420000. Listing Rate: 1 SOL = 350000", "Listing: $OURA, a Pre-IPO contract tracking Oura"]) assert.equal(topicOf(text), null, text);
  assert.equal(topicOf("Token unlock schedule postponed"), "unlock");
  assert.equal(topicOf("$ARB unlock on October 1 has been postponed"), "unlock");
  assert.equal(topicOf("XPL tokens will unlock on October 1"), "unlock");
  assert.equal(topicOf("TEST withdrawals suspended following a security incident"), "security");
  assert.equal(topicOf("We will delist TEST spot trading"), "market");
});

test("Telegram decodes text, preserves breaks, excludes forwards and refuses group/challenge pages", () => {
  const html = `<div class="tgme_channel_history">${message(123, 'TEST token unlock<br>10 &amp; 20 million')}${message(124, undefined, '<a class="tgme_widget_message_forwarded_from">Someone</a>')}${message(125).replace("testnetwork/125", "imposter/125")}</div>`;
  const result = telegramPage(html, source, now);
  assert.equal(result.rows.length, 1); assert.match(result.rows[0].text, /unlock\n10 & 20/);
  assert.deepEqual(result.ids, ["123", "124"]);
  assert.equal(result.rows[0].claimStatus, "official_statement");
  assert.throws(() => telegramPage("<html>Join group</html>", source, now));
  assert.equal(telegramPage(preview([123]), source, now + 8 * 86400000).rows.length, 0);
});

test("X verifies author and excludes quotes, reposts and partial-error responses", () => {
  const s = { ...source, platform: "x", userId: "200" };
  const item = { id: "123", author_id: "200", text: "TEST token unlock event", created_at: new Date(now).toISOString() };
  const parsed = xPage({ data: [item, { ...item, id: "124", author_id: "other" }, { ...item, id: "125", referenced_tweets: [{ type: "quoted" }] }], meta: {} }, s, now);
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].url, "https://x.com/testnetwork/status/123");
  assert.throws(() => xPage({ data: [item], errors: [{ detail: "Partial failure" }], meta: {} }, s, now));
});

test("Discord accepts only configured announcement authors, not user replies, webhooks or hidden text", () => {
  const s = { ...source, platform: "discord", channelId: "100000000000", guildId: "200000000000", authorIds: ["300000000000"] };
  const item = { id: "123", channel_id: s.channelId, author: { id: s.authorIds[0] }, type: 0, content: "TEST token unlock event", timestamp: new Date(now).toISOString() };
  const result = discordPage([item, { ...item, id: "124", author: { id: "outsider" } }, { ...item, id: "125", message_reference: {} }, { ...item, id: "126", webhook_id: "1" }], s, now);
  assert.equal(result.rows.length, 1);
  assert.throws(() => discordPage([{ ...item, content: "" }], s, now), /content unavailable/);
  assert.equal(discordConfig('[{"projectId":"test","channelId":"100000000000","authorIds":[]}]').length, 0);
});

test("official feeds require website-attested feed and article hosts, not aggregator links", () => {
  const accounts = discoverAccounts(`${website}<link rel="alternate" type="application/rss+xml" href="/feed"><link type="application/rss+xml" href="https://unrelated.org/feed"><link type="application/rss+xml" href="/comments/feed/"><link type="application/rss+xml" title="Comments Feed" href="/discussion.xml">`, project, now);
  assert.equal(accounts.filter(p => p.platform === "website").length, 1);
  const s = accounts.find(p => p.platform === "website");
  assert.equal(s.url, "https://testnetwork.org/feed");
  const item = url => `<item><title>TEST token unlock schedule</title><link>${url}</link><pubDate>${new Date(now).toUTCString()}</pubDate></item>`;
  const parsed = websitePage(`<rss><channel>${item("https://testnetwork.org/blog/unlock")}${item("https://evil.org/post")}${item("https://testnetwork.org/blog/post#comment-123")}</channel></rss>`, s, now);
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].platform, "website");
});

test("service verifies sites, publishes separate unlock leads, reports disabled X, and restores after restart", async t => {
  const { service, opts } = serviceFor(t, { read: async url => url === project.website ? website : preview([123]) });
  await Promise.all([service.refresh(), service.refresh()]);
  const state = service.snapshot();
  assert.equal(state.posts.length, 1); assert.equal(state.signals[0].status, "needs_schedule_review");
  assert.equal(state.signals[0].at, undefined); assert.equal(state.signals[0].amount, undefined);
  assert.equal(state.sources.find(s => s.platform === "x").status, "requires_api_token");
  assert.equal(state.coverage.reading, 1);
  const restored = createOfficialSocialService(opts);
  assert.equal(restored.snapshot().posts.length, 1); restored.stop();
  assert.equal(service.query({ search: "nonexistent" }).postTotal, 0);
  assert.equal(service.query({ platform: "telegram" }).sourceTotal, 1);
});

test("pagination resumes across polls without advancing completed cursor before all pages arrive", async t => {
  let clock = now, phase = 0;
  const { service, opts } = serviceFor(t, { now: () => clock, read: async url => {
    if (url === project.website) return website;
    if (!phase) return preview([10]);
    const before = new URL(url).searchParams.get("before");
    return before === "90" ? preview([80], 80) : before === "80" ? preview([70], 70)
      : before === "70" ? preview([60, 10]) : preview([100, 90], 90);
  } });
  await service.refresh(); phase = 1; clock += 121000; await service.refresh();
  let saved = JSON.parse(fs.readFileSync(opts.filePath));
  let tg = Object.values(saved.sources).find(s => s.platform === "telegram");
  assert.equal(tg.cursor, "10"); assert.equal(tg.scan.next, "70");
  assert.equal(service.snapshot().sources.find(s => s.platform === "telegram").status, "catching_up");
  clock += 31000; await service.refresh();
  saved = JSON.parse(fs.readFileSync(opts.filePath)); tg = Object.values(saved.sources).find(s => s.platform === "telegram");
  assert.equal(tg.cursor, "100"); assert.equal(tg.scan, undefined);
  assert.equal(service.snapshot().posts.length, 6);
});

test("provider failure keeps last good data and backs off; edits remove an obsolete unlock lead", async t => {
  let clock = now, fail = false, noise = false, calls = 0;
  const { service } = serviceFor(t, { now: () => clock, read: async url => {
    calls++; if (url === project.website) return website;
    if (fail) throw Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 300000 });
    return preview([123], null, noise ? "Good morning community" : undefined);
  } });
  await service.refresh(); clock += 121000; fail = true; await service.refresh();
  assert.equal(service.snapshot().posts.length, 1);
  assert.equal(service.snapshot().sources.find(s => s.platform === "telegram").status, "rate_limited");
  const before = calls; clock += 31000; await service.refresh(); assert.equal(calls, before);
  clock += 300001; fail = false; noise = true; await service.refresh(); assert.equal(service.snapshot().posts.length, 0);
});

test("removed official links revoke accounts; stale proof is not used during a prolonged website outage", async t => {
  let clock = now, html = website, unavailable = false;
  const { service } = serviceFor(t, { now: () => clock, read: async url => {
    if (url === project.website) { if (unavailable) throw new Error("offline"); return html; } return preview([123]);
  } });
  await service.refresh(); clock += 8 * 86400000; unavailable = true; await service.refresh();
  assert.equal(service.snapshot().posts.length, 0);
  assert.ok(service.snapshot().sources.every(s => s.status === "verification_expired"));
  unavailable = false; html = "<html><body>No social accounts</body></html>"; clock += 7 * 3600000; await service.refresh();
  assert.equal(service.snapshot().sources.length, 0);
});

test("stop aborts in-flight verification and prevents publication of its late result", async t => {
  let finish;
  const { service } = serviceFor(t, { read: () => new Promise(resolve => { finish = resolve; }) });
  const running = service.refresh(); await new Promise(resolve => setImmediate(resolve));
  service.stop(); finish(website); await running;
  assert.equal(service.snapshot().sources.length, 0);
});

test("bot updates publish only website-verified channels and remove edited/forwarded leads", async t => {
  const { service } = serviceFor(t, { read: async url => url === project.website ? website : preview([]) });
  await service.refresh();
  const message = { chat: { id: -1001234567, type: "channel", username: "testnetwork" }, message_id: 100, date: now / 1000, text: "TEST token unlock postponed" };
  service.ingestTelegram({ ...message, chat: { ...message.chat, username: "imposter" } });
  assert.equal(service.snapshot().posts.length, 0);
  service.ingestTelegram(message); assert.equal(service.snapshot().posts.length, 1);
  service.ingestTelegram({ ...message, forward_origin: { type: "channel" } });
  assert.equal(service.snapshot().posts.length, 0);
});

test("Discord collector refuses a configured channel belonging to another guild", async t => {
  const { service } = serviceFor(t, { discordToken: "test-token", discordChannels: [{ projectId: "test", channelId: "100000000000", authorIds: ["300000000000"] }],
    read: async url => {
      if (url === project.website) return '<html><footer><a href="https://discord.gg/testnetwork">Discord</a></footer></html>';
      if (url.includes("/invites/")) return JSON.stringify({ guild: { id: "200000000000" } });
      if (url.includes("/messages")) throw new Error("Messages should not be fetched");
      return JSON.stringify({ guild_id: "400000000000", id: "100000000000", type: 5 });
    } });
  await service.refresh();
  assert.equal(service.snapshot().posts.length, 0);
  assert.match(service.snapshot().sources[0].error, /channel mismatch/);
});

test("an empty Discord API response is not advertised as confirmed access to its message history", () => {
  const result = discordPage([], { ...source, platform: "discord", authorIds: [] }, now);
  assert.equal(result.accessUnknown, true);
});

test("events integration exposes compact coverage and unlock review leads without adding dated calendar rows", t => {
  const { createEventsHub } = require("../eventsHub");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-social-integration-"));
  const hub = createEventsHub({ filePath: path.join(dir, "events.json"),
    unlockService: { snapshot: () => ({ rows: [{ id: "existing", at: now }] }) },
    socialService: { snapshot: () => ({ coverage: { candidates: 1200 }, platforms: {}, updatedAt: now, posts: Array(1000).fill({ text: "large" }),
      signals: [{ id: "social", title: "Unlock schedule postponed", publishedAt: now, status: "needs_schedule_review" }] }),
      subscribe() {}, query: () => ({ posts: [] }), stop() {}, flush: async () => {} } });
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const result = hub.snapshot();
  assert.equal(result.social.coverage.candidates, 1200); assert.equal(result.social.posts, undefined);
  assert.equal(result.unlocks.rows.length, 1); assert.equal(result.unlocks.signals[0].at, undefined);
  assert.equal(result.unlocks.signals[0].publishedAt, now);
});
