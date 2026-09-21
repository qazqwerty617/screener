"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assessNews, publisher, canonicalUrl } = require("../newsVerification");
const { parseArticle, telegramLead, createSourceReader } = require("../newsSources");
const now = Date.now();
const first = { title: "Bybit loses $80 million in Ethereum wallet exploit", alertKind: "security",
  url: "https://www.coindesk.com/markets/bybit", publishedAt: now, originVerified: true };
const second = { ...first, title: "Ethereum wallet exploit costs Bybit $80 million", url: "https://decrypt.co/123/bybit" };

test("one report is withheld; independently worded matching publisher reports are corroborated", () => {
  assert.equal(assessNews(first, [first]).status, "pending");
  assert.equal(assessNews(first, [first, second]).status, "corroborated");
  assert.equal(assessNews(first, [first, { ...second, url: "https://www.coindesk.com/second" }]).status, "pending");
});
test("labels, lookalike domains and user generated official-site pages cannot authenticate sources", () => {
  assert.equal(assessNews({ ...first, originVerified: false, source: "Reuters" }, [second]).status, "pending");
  assert.equal(publisher("https://coindesk.com.evil.example/news"), null);
  assert.equal(publisher("https://www.binance.com/en/square/post/123"), null);
  assert.equal(publisher("https://attacker@www.coindesk.com/news"), null);
});
test("copies, common wire attribution, rumours and changed amounts do not confirm a hack", () => {
  for (const change of [{ title: first.title }, { context: "According to Reuters" }, { context: "Sponsored content" },
    { title: second.title.replace("80", "800") }, { title: `Unconfirmed: ${second.title}` },
    { title: "Ethereum wallet exploit costs Binance $80 million" },
    { title: "Bybit prevents $80 million Ethereum wallet exploit" },
    { title: "Binance loses $80 million in Ethereum hot wallet exploit" }]) {
    assert.equal(assessNews(first, [first, { ...second, ...change }]).status, "pending", JSON.stringify(change));
  }
});
test("a denial blocks publication and stale reports cannot corroborate current news", () => {
  const denial = { ...second, title: "Bybit denies Ethereum wallet exploit" };
  assert.equal(assessNews(first, [first, second, denial]).status, "disputed");
  assert.equal(assessNews(first, [first, { ...second, publishedAt: now - 3 * 3600000 }]).status, "pending");
});
test("an authenticated official statement qualifies without claiming ownership of unrelated incidents", () => {
  const fed = { ...first, title: "Federal Reserve issues FOMC statement", alertKind: "macro", url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260921a.htm" };
  assert.equal(assessNews(fed, [fed]).status, "official");
  const exchange = { ...first, title: "Bybit reports a security breach", url: "https://announcements.bybit.com/en/article/security" };
  assert.equal(assessNews(exchange, [exchange]).status, "official");
  assert.equal(assessNews({ ...exchange, title: "Bybit warns users about Binance hack" }, []).status, "pending");
});
test("article verification uses publisher metadata and rejects undated or stale pages", () => {
  const html = `<meta property="og:title" content="Actual publisher headline"><meta property="article:published_time" content="${new Date(now).toISOString()}">`;
  assert.equal(parseArticle(html, first.url, value => value, now).title, "Actual publisher headline");
  assert.equal(parseArticle('<meta property="og:title" content="Fake">', first.url, value => value, now), null);
  assert.equal(parseArticle(html, "https://unknown.example/report", value => value, now), null);
});
test("Telegram accepts only selected channel IDs, and remains an unverified lead", () => {
  const post = { chat: { id: -100123, type: "channel", username: "selected" }, message_id: 12, date: now / 1000, text: "Bybit Ethereum wallet hack report" };
  assert.equal(telegramLead(post, [], now), null);
  assert.equal(telegramLead(post, ["-100123"], now).originVerified, false);
  assert.equal(telegramLead({ ...post, chat: { ...post.chat, type: "private" } }, ["-100123"], now), null);
});
test("source reader reuses conditional responses and backs off an unavailable publisher", async () => {
  let calls = 0;
  const read = createSourceReader({ now: () => now, request: async (url, options) => {
    calls++;
    if (calls === 1) return new Response("feed", { headers: { etag: '"one"' } });
    assert.equal(options.headers["If-None-Match"], '"one"');
    if (calls === 2) return new Response(null, { status: 304 });
    return new Response(null, { status: 429 });
  } });
  assert.equal(await read(first.url), "feed");
  assert.equal(await read(first.url), "feed");
  await assert.rejects(read(first.url)); await assert.rejects(read(first.url));
  assert.equal(calls, 3);
  assert.equal(canonicalUrl(`${first.url}?utm_source=telegram#copy`), first.url);
});
