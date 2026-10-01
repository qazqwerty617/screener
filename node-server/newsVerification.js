"use strict";

// Identity comes from the fetched publisher's URL, never a provider's source label.
const PUBLISHERS = [
  ["blog.sui.io", "sui", "Sui", "official"], ["blog.arbitrum.io", "arbitrum", "Arbitrum", "official"],
  ["sui.io", "sui", "Sui", "official"],
  ["coindesk.com", "coindesk", "CoinDesk"], ["cointelegraph.com", "cointelegraph", "Cointelegraph"],
  ["theblock.co", "theblock", "The Block"], ["decrypt.co", "decrypt", "Decrypt"],
  ["federalreserve.gov", "fed", "Federal Reserve", "macro"],
  ["sec.gov", "sec", "SEC", "official"], ["whitehouse.gov", "whitehouse", "White House", "macro"],
  ["bybit.com", "bybit", "Bybit", "exchange"], ["binance.com", "binance", "Binance", "exchange"],
  ["okx.com", "okx", "OKX", "exchange"], ["kucoin.com", "kucoin", "KuCoin", "exchange"],
  ["gate.com", "gate", "Gate.io", "exchange"], ["mexc.com", "mexc", "MEXC", "exchange"],
  ["asterdex.com", "aster", "Aster", "exchange"], ["bitget.com", "bitget", "Bitget", "exchange"],
  ["dlnews.com", "dlnews", "DL News"], ["blockworks.co", "blockworks", "Blockworks"], ["blockworks.com", "blockworks", "Blockworks"]
];
function publisher(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
    const origin = PUBLISHERS.find(([host]) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    if (!origin) return null;
    const officialPaths = { sui: parsed.hostname === "blog.sui.io" ? /^\/[^/]+/ : /^\/blog\/[^/]+/, arbitrum: /^\/[^/]+/, binance: /\/support\/announcement\//, bybit: /\//,
      okx: /\/help\//, kucoin: /\/announcement\//, fed: /\/newsevents\/pressreleases\//,
      sec: /\/(?:newsroom\/press-releases|news\/press-release)\//, whitehouse: /\/(?:presidential-actions|briefings-statements)\//,
      gate: /^\/announcements\/article\/\d+$/, mexc: /^\/(?:support|announcements)\/article\//,
      aster: /^\/[a-z]{2}\/announcement\/\d+$/, bitget: /^\/(?:[a-z]{2}(?:[-_][A-Z]{2})?\/)?support\/articles\/\d+\/?$/ };
    if (origin[3] && (!officialPaths[origin[1]].test(parsed.pathname) || origin[1] === "bybit" && parsed.hostname !== "announcements.bybit.com")) return null;
    return origin;
  } catch (_) { return null; }
}
function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch (_) { return null; }
}
const STOP = new Set(("the a an to of in on at by for from with and or as is was are were be been has have had its after before over new amid crypto cryptocurrency exchange protocol token coin funds million billion dollars usd usdt says said reports report reportedly about following breaking news suffers suffered loses lost hacked hack exploit exploited attack stolen security breach announces announced will major markets market today this that it into through more than loss worth suspected possible potential according confirms confirmed" ).split(" "));
for (const word of "wallet wallets hot cold costs cost hackers hacker losses users user bridge network smart contract contracts platform project firm defi drains drained compromise compromised detected hits hit".split(" ")) STOP.add(word);
const DOUBT = /\b(rumou?rs?|unconfirmed|alleged(?:ly)?|reportedly|could|might|may|suspected|possible|potential|if|last year|years? ago|anniversary)\b/i;
const DENIAL = /\b(denies?|denied|refutes?|debunks?|fake|false|hoax|not hacked|no (?:hack|exploit|breach)|never (?:hacked|exploited))\b/i;
function words(title) {
  return [...new Set(String(title).toLowerCase().replace(/hack(?:ed|ing)?/g, "hack").replace(/exploit(?:ed|ation)?/g, "exploit")
    .match(/[a-z][a-z0-9]{1,}/g) || [])].filter(word => !STOP.has(word));
}
function subjects(title) {
  return new Set((String(title).match(/\b[A-Z][A-Za-z0-9]{2,}\b/g) || []).map(word => word.toLowerCase()).filter(word => !STOP.has(word)));
}
function sameSubject(a, b) {
  const names = subjects(a.title);
  return [...subjects(b.title)].some(name => names.has(name));
}
function amounts(title) {
  return [...String(title).toLowerCase().replace(/,/g, "").matchAll(/\$\s*(\d+(?:\.\d+)?)\s*(billion|million|bn|[mbk])?/g)]
    .map(([, n, unit]) => Number(n) * ({ billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, m: 1e6, k: 1e3 }[unit] || 1)).sort((a, b) => a - b).join(",");
}
// Headlines are prose, not identical bags of capitalized words. Isolate the
// victim and loss of a security incident before comparing publishers' wording.
function securityClaim(title) {
  const text = String(title).replace(/^[\s\"'“”]+/, "");
  const primary = text.split(/\b(?:after|amid|as crypto|days? after|weeks? after)\b/i)[0];
  if (!/\b(?:hack(?:ed|ers?)?|exploit(?:ed)?|breach|attack|heist|stolen|drained)\b/i.test(primary)) return null;
  let victim = /\b(?:costs?|hits?|targets?)\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*){0,3})(?=\s+\$|\s+(?:with|in|for|as|after)\b|[,.:]|$)/.exec(primary)?.[1];
  victim ||= /^(.{2,80}?)\s+(?:suffers?|suffered|loses?|lost|hit\s+by|hacked|exploited|pauses?|suspends?|halts?|denies?|denied|confirms?|reports?|has\s+been|was|is)\b/i.exec(primary)?.[1];
  victim ||= /\b(?:stolen|drained)\s+from\s+(.{2,60}?)(?=\s+(?:in|after|as|following)\b|[,.:]|$)/i.exec(primary)?.[1];
  if (!victim) return null;
  victim = victim.toLowerCase().replace(/^(?:the |company |exchange |protocol )+/, "").replace(/\s+/g, " ").trim();
  // Prevented attacks and recovery stories do not independently establish loss.
  const outcome = /\b(?:prevent(?:s|ed)?|avert(?:s|ed)?|thwart(?:s|ed)?|blocks?|blocked|patch(?:es|ed)?|fix(?:es|ed)?)\b/i.test(primary) ? "prevented"
    : /\b(?:recover(?:s|ed)?|return(?:s|ed)?|repaid|arrest(?:s|ed)?|sentenced)\b/i.test(primary) ? "aftermath" : "incident";
  return { victim, amount: amounts(primary), outcome, primary };
}
function sameClaim(a, b) {
  if ((a.alertKind || "news") !== (b.alertKind || "news")) return false;
  if (a.alertKind === "security") {
    const left = securityClaim(a.title), right = securityClaim(b.title);
    if (left && right) {
      if (left.victim !== right.victim || left.outcome !== right.outcome || left.amount !== right.amount) return false;
      // A matching explicit loss plus a named victim is a stronger signature
      // than incidental vocabulary shared by two articles about crypto.
      if (left.amount) return true;
    }
  }
  if (!sameSubject(a, b)) return false;
  const leftNames = subjects(a.title), rightNames = subjects(b.title);
  if (leftNames.size !== rightNames.size || [...leftNames].some(name => !rightNames.has(name))) return false;
  const phase = title => /\b(prevent(?:s|ed)?|blocks?|blocked|averts?|thwarts?|patch(?:es|ed)?|fix(?:es|ed)?)\b/i.test(title) ? "prevented"
    : /\b(recover(?:s|ed)?|return(?:s|ed)?|repaid|arrest(?:s|ed)?|sentenced)\b/i.test(title) ? "aftermath"
    : /\b(pause[sd]?|delay[sd]?|suspend[sd]?|cancel[sl]?ed|cut[st]?|lower[sd]?)\b/i.test(title) ? "decrease"
    : /\b(hike[sd]?|raise[sd]?|increase[sd]?|impose[sd]?)\b/i.test(title) ? "increase" : "event";
  if (phase(a.title) !== phase(b.title)) return false;
  const left = words(a.title), right = new Set(words(b.title));
  const common = left.filter(word => right.has(word)).length;
  if (common < 2 || common / Math.max(left.length, right.size, 1) < 0.65) return false;
  // Different reported losses or quoted numbers are not corroboration.
  if (amounts(a.title) !== amounts(b.title)) return false;
  const numbers = title => (String(title).match(/\d+(?:\.\d+)?%?/g) || []).join(",");
  if (!amounts(a.title) && numbers(a.title) !== numbers(b.title)) return false;
  return true;
}
function attribution(item) {
  const text = `${item.title} ${item.context || ""}`;
  const match = /(?:according to|reported by|reports? from|citing|via|source:)\s+(reuters|bloomberg|coindesk|cointelegraph|the block|decrypt|peckshield|certik|slowmist|[\w@.-]+)/i.exec(text);
  return match?.[1].toLowerCase().replace(/\s/g, "") || null;
}
function evidence(item) {
  const origin = publisher(item.url);
  if (origin && !origin[3] && /(?:press[- ]releases?|sponsored|advertorial|paid (?:content|partnership))/i.test(`${item.url} ${item.title} ${item.context || ""}`)) return null;
  return origin && item.originVerified ? { name: origin[2], url: item.url, publisher: origin[1] } : null;
}
function assessNews(item, rows) {
  const own = evidence(item);
  const origin = publisher(item.url);
  if (!own) return { status: "pending", sources: [] };
  const relevant = rows.filter(other => evidence(other) && Math.abs(other.publishedAt - item.publishedAt) <= 2 * 3600000);
  const deniedSubject = other => {
    const left = securityClaim(item.title), right = securityClaim(other.title);
    return left && right ? left.victim === right.victim : sameSubject(item, other);
  };
  const denial = other => DENIAL.test(securityClaim(other.title)?.primary || other.title);
  if (denial(item) || relevant.some(other => other !== item && denial(other) && deniedSubject(other) &&
    (item.alertKind === other.alertKind || /hack|exploit|breach/i.test(item.title) && /hack|exploit|breach/i.test(other.title)))) {
    return { status: "disputed", sources: [own] };
  }
  if (DOUBT.test(item.title)) return { status: "pending", sources: [own] };
  // A primary publisher speaks for itself, not for incidents at unrelated projects.
  const ownIncident = new RegExp(`\\b${origin[1]} (?:confirms? (?:a|the|its)|suffers?|reports? (?:a|the|its)|was|has been|is)\\b`, "i").test(item.title);
  if (origin[3] && (item.alertKind !== "security" && item.alertKind !== "risk" || ownIncident) &&
    (origin[3] !== "exchange" || new RegExp(`\\b${origin[1]}\\b`, "i").test(item.title))) {
    return { status: "official", sources: [own] };
  }
  const sources=[own],seen=new Set([own.publisher]);
  for (const other of relevant) {
    const second = evidence(other);
    if (seen.has(second.publisher) || DOUBT.test(other.title) || denial(other) || !sameClaim(item, other)) continue;
    const a = attribution(item), b = attribution(other);
    // Syndication, identical headlines and a common quoted wire remain one report.
    if (a || b || item.title.toLowerCase().replace(/\W/g, "") === other.title.toLowerCase().replace(/\W/g, "")) continue;
    sources.push(second);seen.add(second.publisher);
  }
  if(sources.length>1)return {status:"corroborated",sources};
  // A named publisher's ordinary reporting can appear as a sourced report.
  // Security, solvency and market-moving alerts still require independent evidence.
  return item.alertKind ? { status: "pending", sources: [own] } : { status: "reported", sources: [own] };
}
const isPublished = item => ["official", "corroborated", "reported"].includes(item.verification?.status);
module.exports = { publisher, canonicalUrl, assessNews, sameClaim, isPublished };
