"use strict";

const { publisher, canonicalUrl } = require("./newsVerification");
// Independent category requests prevent promotional posts from pushing listings
// and security notices off the first page. CMS endpoints may change independently.
const ANNOUNCEMENT_FEEDS = Object.freeze([
  ...[48, 49, 161].map(id => ["Binance", `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=50&catalogId=${id}`]),
  ...["new_crypto", "delistings", "latest_bybit_news", "maintenance_updates"].map(type => ["Bybit", `https://api.bybit.com/v5/announcements/index?locale=en-US&limit=50&type=${type}`]),
  ...["security", "coin_listings", "symbol_delisting", "maintenance_system_updates"].map(type => ["Bitget", `https://api.bitget.com/api/v2/public/annoucements?language=en_US&annType=${type}&limit=10`]),
]);

function parseAnnouncements(payload, source, now = Date.now()) {
  let articles;
  if (source === "Binance" && payload?.code === "000000") {
    articles = (payload.data?.catalogs || []).flatMap(c => c.articles || []);
    if (Array.isArray(payload.data?.articles)) articles.push(...payload.data.articles);
    articles = articles.map(a => ({ title: a.title, publishedAt: Number(a.releaseDate),
      url: /^[a-f0-9]{32}$/i.test(a.code || "") ? `https://www.binance.com/en/support/announcement/${a.code}` : null }));
  } else if (source === "Bybit" && payload?.retCode === 0 && Array.isArray(payload.result?.list)) {
    articles = payload.result.list.map(a => ({ title: a.title, context: a.description,
      publishedAt: Number(a.publishTime || a.dateTimestamp), url: a.url }));
  } else if (source === "Bitget" && payload?.code === "00000" && Array.isArray(payload.data)) {
    articles = payload.data.map(a => ({ title: a.annTitle, context: a.annDesc, publishedAt: Number(a.cTime), url: a.annUrl }));
  } else throw new Error(`${source} announcement response invalid`);
  return articles.flatMap(a => {
    const title = String(a.title || "").replace(/<[^>]*>/g, " ").trim().slice(0, 300);
    const url = canonicalUrl(a.url);
    if (!title || !url || publisher(url)?.[2] !== source || !Number.isFinite(a.publishedAt) ||
      a.publishedAt > now + 60000 || a.publishedAt < now - 7 * 86400000) return [];
    if (!/\b(list(?:s|ed|ing)?|launch(?:es|ing)?|delist\w*|suspend\w*|hack\w*|exploit\w*|breach|security|maintenance|outage|withdrawals?|network upgrade|token swap)\b/i.test(title)) return [];
    if (/\b(prize pool|competition|cashback|airdrop|earn|win|rewards?|bonus)\b/i.test(title) && !/\b(list(?:ing)?|delist\w*|hack\w*|exploit\w*|breach|suspend\w*)\b/i.test(title)) return [];
    return [{ id: url, title, context: String(a.context || "").slice(0, 1200), url, source,
      publishedAt: a.publishedAt, originVerified: true }];
  });
}

function listingAnnouncements(news) {
  return news.filter(item => item.originVerified && publisher(item.url)?.[3] === "exchange" &&
    /\b(list(?:s|ed|ing)?|delist\w*|launch\w*)\b/i.test(item.title) &&
    !/\b(launchpool|airdrop|earn|prize pool|competition)\b/i.test(item.title)).map(item => ({
      id: item.url, title: item.title, titleRu: item.titleRu, url: item.url, source: item.source,
      publishedAt: item.publishedAt, kind: /\bdelist/i.test(item.title) ? "delisting" : "listing",
      // Publication time is never represented as the opening time of a market.
      exchange: { Binance: "BN", Bybit: "BB", Bitget: "BG", "Gate.io": "GT", MEXC: "MX", OKX: "OX", KuCoin: "KC" }[item.source],
    }));
}

module.exports = { ANNOUNCEMENT_FEEDS, parseAnnouncements, listingAnnouncements };
