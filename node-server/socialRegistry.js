"use strict";

const { parseDocument } = require("htmlparser2");
const { findAll } = require("domutils");

// These are roots of trust, not assertions that the social accounts are reachable.
// Every account still needs a link on the fetched project website.
const SEEDS = [
  ["plasma", "Plasma", "XPL", "https://www.plasma.org/", "plasma"],
  ["arbitrum", "Arbitrum", "ARB", "https://arbitrum.io/", "arbitrum"],
  ["aptos", "Aptos", "APT", "https://aptosnetwork.com/", "Aptos"],
  ["sui", "Sui", "SUI", "https://www.sui.io/", "SuiNetwork"],
  ["optimism", "Optimism", "OP", "https://optimism.io/", "Optimism"],
  ["starknet", "Starknet", "STRK", "https://www.starknet.io/", "Starknet"],
  ["pyth", "Pyth", "PYTH", "https://www.pyth.network/", "PythNetwork"],
  ["celestia", "Celestia", "TIA", "https://celestia.org/", "celestia"],
  ["wormhole", "Wormhole", "W", "https://wormhole.com/", "wormhole"],
  ["zksync", "ZKsync", "ZK", "https://www.zksync.io/", "zksync"],
  ["ethena", "Ethena", "ENA", "https://ethena.fi/", "ethena"],
  ["layerzero", "LayerZero", "ZRO", "https://layerzero.network/", "LayerZero_Core"],
  ["binance", "Binance", "BNB", "https://www.binance.com/en/community", "binance"],
  ["bybit", "Bybit", "", "https://www.bybit.com/en/", "Bybit_Official"],
  ["bitget", "Bitget", "BGB", "https://www.bitget.com/", "bitgetglobal"],
  ["gate", "Gate", "GT", "https://www.gate.com/", "gate_io"]
].map(([id, name, symbol, website, twitter]) => ({ id, name, symbol, website, twitter, discovery: "curated" }));

function websiteUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.includes(".") ||
      /^(?:localhost|.*\.(?:local|localhost|internal|test))$/i.test(url.hostname)) return null;
    url.hash = ""; url.search = "";
    return url.href;
  } catch (_) { return null; }
}

function catalogProjects(payload) {
  if (!Array.isArray(payload) || !payload.length) throw new Error("Invalid project catalog");
  const result = [], seen = new Set(SEEDS.map(p => p.twitter.toLowerCase()));
  for (const p of [...payload].sort((a, b) => (Number(b?.tvl) || 0) - (Number(a?.tvl) || 0))) {
    const website = websiteUrl(p?.url), twitter = String(p?.twitter || "").replace(/^@/, "");
    if (!website || !/^[a-z\d_]{1,15}$/i.test(twitter) || seen.has(twitter.toLowerCase())) continue;
    // Aggregator identities only discover candidates; they never authenticate posts.
    seen.add(twitter.toLowerCase());
    result.push({ id: `llama:${String(p.id).slice(0, 80)}`, name: String(p.name || twitter).slice(0, 100),
      symbol: String(p.symbol || "").replace(/^-$/, "").slice(0, 30), website, twitter,
      discovery: "https://api.llama.fi/protocols" });
  }
  return result;
}

function socialLink(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    const host = u.hostname.replace(/^www\./, ""), parts = u.pathname.split("/").filter(Boolean);
    if (["x.com", "twitter.com"].includes(host) && parts.length === 1 && /^[a-z\d_]{1,15}$/i.test(parts[0]) &&
      !/^(?:share|intent|home|search|i|login)$/i.test(parts[0])) return { platform: "x", account: parts[0].toLowerCase(), url: `https://x.com/${parts[0]}` };
    if (host === "t.me" && parts.length === 1 && /^[a-z][a-z\d_]{3,31}$/i.test(parts[0]) &&
      !/^(?:share|joinchat|proxy|socks|addstickers)$/i.test(parts[0])) return { platform: "telegram", account: parts[0].toLowerCase(), url: `https://t.me/${parts[0]}` };
    const invite = host === "discord.gg" && parts.length === 1 ? parts[0]
      : host === "discord.com" && parts[0] === "invite" && parts.length === 2 ? parts[1] : null;
    if (invite && /^[a-z\d_-]{2,100}$/i.test(invite)) return { platform: "discord", account: invite, url: `https://discord.gg/${invite}` };
  } catch (_) {}
  return null;
}

function editorialUrl(raw, title = "") {
  try {
    const u = new URL(raw);
    return !!websiteUrl(raw) && !/(?:^|\/)(?:comments?|forum|community|square)(?:\/|$)|comment-page/i.test(u.pathname) &&
      !/comment|replytocom/i.test(u.search + u.hash) && !/\bcomments?\b|комментар/iu.test(title);
  } catch (_) { return false; }
}

function discoverAccounts(html, project, checkedAt) {
  const doc = parseDocument(html), found = new Map();
  for (const anchor of findAll(n => n.name === "a" && n.attribs?.href, doc.children)) {
    const link = socialLink(anchor.attribs.href);
    if (!link) continue;
    if (link.platform === "x" && link.account !== project.twitter.toLowerCase()) continue;
    // Do not mistake a partner, embedded article or community comment for the
    // project's own channel. Non-X links must be in navigation/footer/social UI.
    if (link.platform !== "x") {
      let nav = false;
      for (let n = anchor; n && n !== doc; n = n.parent) {
        if (["footer", "nav", "header"].includes(n.name) || /social|footer/i.test(`${n.attribs?.class || ""} ${n.attribs?.id || ""}`)) nav = true;
      }
      if (!nav) continue;
    }
    found.set(`${link.platform}:${link.account}`, { ...link, projectId: project.id, project: project.name,
      symbol: project.symbol, evidenceUrl: project.website, verifiedAt: checkedAt });
  }
  for (const node of findAll(n => n.name === "link" && /application\/(?:rss|atom)\+xml/i.test(n.attribs?.type || ""), doc.children)) {
    try {
      const feed = new URL(node.attribs.href, project.website), host = new URL(project.website).hostname.replace(/^www\./, "");
      if (editorialUrl(feed.href, node.attribs.title || "") && (feed.hostname === host || feed.hostname.endsWith(`.${host}`))) {
        found.set(`website:${feed.href}`, { platform: "website", account: feed.href, url: feed.href,
          projectId: project.id, project: project.name, symbol: project.symbol, evidenceUrl: project.website, verifiedAt: checkedAt });
      }
    } catch (_) {}
  }
  return [...found.values()];
}

module.exports = { SEEDS, websiteUrl, socialLink, editorialUrl, catalogProjects, discoverAccounts };
