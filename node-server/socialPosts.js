"use strict";
const { parseDocument } = require("htmlparser2");
const { findAll, textContent } = require("domutils");
const { editorialUrl } = require("./socialRegistry");
const DAY = 86400000;
const hasClass = (n, name) => (n.attribs?.class || "").split(/\s+/).includes(name);

function topicOf(text) {
  const t = String(text);
  // Promotions often borrow words like "listing", "unlock" and "launch".
  if (/\b(giveaway|trading (?:competition|contest)|win (?:a share|prizes|up to)|prize pool|retweet|airdrop (?:campaign|giveaway))\b|розыгрыш|торговый конкурс|призов/iu.test(t)) return null;
  if (/\b(presale (?:rate|time)|listing rate|soft\s*\/\s*hard cap|pre-ipo|stock of|tokeni[sz]ed stocks?)\b/i.test(t)) return null;
  if (/\b(exploit(?:ed)?|hacked|security (?:incident|breach)|withdrawals? (?:halted|suspended)|network (?:outage|halt))\b|взлом|приостанов[а-я]* вывод/iu.test(t)) return "security";
  if (/\b(?:token unlocks?|unlock (?:schedule|event)|vesting|supply release)\b|разлок|разблокировк[а-я]* токен/iu.test(t) ||
    /(?:\$[A-Z\d]{2,12}|\b[A-Z]{2,12})\s+(?:tokens?\s+)?(?:will\s+)?unlocks?\b/.test(t)) return "unlock";
  if (/\b(delist(?:ing|ed)?|will (?:list|launch).*?(?:spot|perpetual|trading)|listing|trading (?:starts|opens)|tokenomics|token burn|supply (?:change|reduction)|mainnet (?:upgrade|halt)|network upgrade)\b|делистинг|листинг|токеномик|сжигание токен/iu.test(t)) return "market";
  return null;
}

function postTitle(text) {
  const lines = String(text).split(/\n+/).map(s => s.trim()).filter(s => /[\p{L}\p{N}]/u.test(s) && !/^.{0,40}official update\s*$/i.test(s));
  return (lines[0] || String(text)).slice(0, 220);
}

function post(source, id, content, publishedAt, now, extra = {}) {
  if (!/^\d{1,25}$/.test(String(id)) || !Number.isFinite(publishedAt) || publishedAt < now - 7 * DAY || publishedAt > now + 60000) return null;
  const text = String(content || "").replace(/\u0000/g, "").trim().slice(0, 6000), topic = topicOf(text);
  if (!topic) return null;
  const url = source.platform === "telegram" ? `https://t.me/${source.account}/${id}`
    : source.platform === "x" ? `https://x.com/${source.account}/status/${id}`
    : `https://discord.com/channels/${source.guildId}/${source.channelId}/${id}`;
  return { id: `${source.platform}:${source.account}:${id}`, sourceId: source.id, platform: source.platform,
    projectId: source.projectId, project: source.project, symbol: source.symbol, account: source.account,
    title: postTitle(text), text, topic, url, publishedAt, receivedAt: now,
    evidenceUrl: source.evidenceUrl, verifiedAt: source.verifiedAt, originVerified: true,
    claimStatus: "official_statement", ...extra };
}

function telegramPage(html, source, now) {
  const doc = parseDocument(String(html).replace(/<br\s*\/?\s*>/gi, "\n"));
  const widgets = findAll(n => hasClass(n, "tgme_widget_message") && n.attribs?.["data-post"], doc.children);
  // Telegram groups and login/challenge pages must not be reported as healthy empty feeds.
  if (!findAll(n => hasClass(n, "tgme_channel_history"), doc.children).length) throw new Error("Public channel preview unavailable");
  const rows = [], ids = [];
  for (const widget of widgets) {
    const [account, id] = widget.attribs["data-post"].split("/");
    if (account.toLowerCase() !== source.account.toLowerCase() || !/^\d+$/.test(id)) continue;
    ids.push(id);
    if (findAll(n => hasClass(n, "tgme_widget_message_forwarded_from"), [widget]).length) continue;
    const message = findAll(n => hasClass(n, "tgme_widget_message_text"), [widget])[0];
    const time = findAll(n => n.name === "time" && n.attribs?.datetime, [widget])[0];
    const item = post(source, id, message ? textContent(message) : "", Date.parse(time?.attribs.datetime || ""), now);
    if (item) rows.push(item);
  }
  const next = findAll(n => n.name === "a" && hasClass(n, "tme_messages_more") && n.attribs?.["data-before"], doc.children)[0]?.attribs["data-before"];
  return { rows, ids, next: /^\d+$/.test(next || "") ? next : null };
}

function xPage(payload, source, now) {
  if (payload.errors?.length || !payload.meta || payload.data != null && !Array.isArray(payload.data)) throw new Error("Invalid X timeline");
  const rows = [], ids = [];
  for (const item of payload.data || []) {
    if (!/^\d+$/.test(item.id || "") || item.author_id !== source.userId) continue;
    ids.push(item.id);
    if (item.referenced_tweets?.some(ref => ["retweeted", "quoted", "replied_to"].includes(ref.type))) continue;
    const row = post(source, item.id, item.note_tweet?.text || item.text, Date.parse(item.created_at), now);
    if (row) rows.push(row);
  }
  return { rows, ids, next: typeof payload.meta.next_token === "string" ? payload.meta.next_token : null };
}

function discordPage(payload, source, now) {
  if (!Array.isArray(payload)) throw new Error("Invalid Discord messages");
  const rows = [], ids = []; let hiddenContent = false;
  for (const item of payload) {
    if (!/^\d+$/.test(item.id || "") || item.channel_id !== source.channelId) continue;
    ids.push(item.id);
    if (![0, 19].includes(item.type) || item.message_reference || item.webhook_id || !source.authorIds.includes(item.author?.id)) continue;
    if (!item.content && !item.embeds?.length && !item.attachments?.length) hiddenContent = true;
    const text = [item.content, ...(item.embeds || []).flatMap(e => [e.title, e.description])].filter(Boolean).join("\n");
    const row = post(source, item.id, text, Date.parse(item.timestamp), now, { authorId: item.author.id });
    if (row) rows.push(row);
  }
  if (hiddenContent) throw new Error("Discord message content unavailable");
  return { rows, ids, accessUnknown: payload.length === 0,
    next: payload.length === 100 && ids.length ? ids.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b) : null };
}

function socialUnlockSignals(posts) {
  return posts.filter(p => p.originVerified && p.topic === "unlock").map(p => ({ id: p.id, title: p.title, url: p.url,
    source: `${p.project} · ${p.platform}`, publishedAt: p.publishedAt, evidenceUrl: p.evidenceUrl,
    status: "needs_schedule_review" }));
}
function telegramBotPost(message, source, now) {
  if (message?.chat?.type !== "channel" || message.chat.username?.toLowerCase() !== source.account ||
    message.forward_origin || message.forward_from_chat || message.forward_date || message.is_automatic_forward) return null;
  return post(source, message.message_id, message.text || message.caption, Number(message.date) * 1000, now);
}
function websitePage(xml, source, now) {
  const doc = parseDocument(xml, { xmlMode: true });
  if (!findAll(n => ["rss", "feed", "rdf:RDF"].includes(n.name), doc.children).length) throw new Error("Invalid official feed");
  const rows = [];
  for (const entry of findAll(n => ["item", "entry"].includes(n.name), doc.children).slice(0, 200)) {
    const field = name => entry.children?.find(n => n.name === name);
    const value = name => field(name) ? textContent(field(name)) : "";
    const link = entry.children?.find(n => n.name === "link" && (!n.attribs?.rel || n.attribs.rel === "alternate"));
    try {
      const url = new URL(link?.attribs?.href || (link ? textContent(link) : ""));
      const host = new URL(source.evidenceUrl).hostname.replace(/^www\./, "");
      if (!editorialUrl(url.href) || !(url.hostname === host || url.hostname.endsWith(`.${host}`))) continue;
      const publishedAt = Date.parse(value("pubDate") || value("published") || value("dc:date"));
      const text = textContent(parseDocument(`${value("title")}\n${value("description") || value("summary") || value("content")}`)).trim().slice(0, 6000);
      const row = post({ ...source, platform: "telegram" }, "1", text, publishedAt, now);
      if (row) rows.push({ ...row, id: `website:${url.href}`, platform: "website", url: url.href });
    } catch (_) {}
  }
  return { rows, ids: [], next: null };
}
module.exports = { topicOf, postTitle, telegramPage, telegramBotPost, xPage, discordPage, websitePage, socialUnlockSignals };
