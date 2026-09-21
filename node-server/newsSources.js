"use strict";

const { publisher, canonicalUrl } = require("./newsVerification");

function createSourceReader({ request = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async function read(url) {
    const previous = cache.get(url) || {};
    if (previous.retryAt > now()) throw new Error("Source backoff");
    const headers = { "User-Agent": "ObsidianScreener/1.0", Accept: "application/rss+xml,application/xml,text/html,application/json" };
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    if (previous.modified) headers["If-Modified-Since"] = previous.modified;
    try {
      const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(7000) });
      if (response.status === 304 && previous.body != null) return previous.body;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("Source too large");
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error("Source too large");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      cache.delete(url);
      cache.set(url, { body, etag: response.headers.get("etag"), modified: response.headers.get("last-modified"), failures: 0 });
      while (cache.size > 80) cache.delete(cache.keys().next().value);
      return body;
    } catch (error) {
      const failures = Math.min((previous.failures || 0) + 1, 5);
      cache.set(url, { ...previous, failures, retryAt: now() + Math.min(300000, 10000 * 2 ** failures) });
      while (cache.size > 80) cache.delete(cache.keys().next().value);
      throw error;
    }
  };
}

function parseArticle(html, url, decode, now = Date.now()) {
  const origin = publisher(url);
  if (!origin) return null;
  const meta = new Map();
  for (const tag of String(html).matchAll(/<meta\s[^>]{1,3000}>/gi)) {
    const attrs = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(([, key, value]) => [key.toLowerCase(), value]));
    const key = attrs.property || attrs.name;
    if (key && attrs.content) meta.set(key.toLowerCase(), decode(attrs.content));
  }
  const title = meta.get("og:title") || meta.get("twitter:title");
  const publishedAt = Date.parse(meta.get("article:published_time") || meta.get("date") || "");
  // Never reuse the lead's headline or timestamp when the publisher cannot attest them.
  if (!title || !Number.isFinite(publishedAt) || now - publishedAt > 7 * 86400000 || publishedAt > now + 60000) return null;
  return { id: canonicalUrl(url), url: canonicalUrl(url), title: title.slice(0, 300),
    context: (meta.get("og:description") || "").slice(0, 1200), source: origin[2], publishedAt, originVerified: true };
}

function telegramLead(message, channelIds, now = Date.now()) {
  if (!message || message.chat?.type !== "channel" || !channelIds.includes(String(message.chat.id)) || !message.chat.username) return null;
  const title = String(message.text || message.caption || "").slice(0, 300);
  const publishedAt = Number(message.date) * 1000;
  if (title.length < 12 || !Number.isFinite(publishedAt) || now - publishedAt > 15 * 60000 || publishedAt > now + 60000) return null;
  const fullText = message.text || message.caption || "";
  const links = (message.entities || message.caption_entities || []).map(entity => entity.type === "text_link" ? entity.url
    : entity.type === "url" ? fullText.slice(entity.offset, entity.offset + entity.length) : null);
  const articleUrl = links.find(url => publisher(url));
  return { id: `telegram:${message.chat.id}:${message.message_id}`, title, publishedAt,
    url: articleUrl || `https://t.me/${message.chat.username}/${message.message_id}`,
    source: `Telegram · ${message.chat.username}`, originVerified: false };
}

module.exports = { createSourceReader, parseArticle, telegramLead };
