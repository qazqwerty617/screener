"use strict";

const EXCHANGES = Object.freeze({
  BN: { name: "Binance", fee: 0.05, interval: 8 },
  BB: { name: "Bybit", fee: 0.055, interval: 8 },
  OX: { name: "OKX", fee: 0.05, interval: 8 },
  BG: { name: "Bitget", fee: 0.06, interval: 8 },
  GT: { name: "Gate.io", fee: 0.05, interval: 8 },
  MX: { name: "MEXC", fee: 0.06, interval: 8 },
  KC: { name: "KuCoin", fee: 0.06, interval: 8 },
  BX: { name: "BingX", fee: 0.05, interval: 8 },
  HT: { name: "HTX", fee: 0.05, interval: 8 },
  HL: { name: "Hyperliquid", fee: 0.045, interval: 1 },
  AD: { name: "Asterdex", fee: 0.04, interval: 8 },
});

const ALIASES = Object.freeze({ XBT: "BTC", XDG: "DOGE", POL: "MATIC", LUNA2: "LUNA" });

const STOCK_ROOTS_ARBITRAGE = [
  "AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOG", "GOOGL", "META", "NFLX", "COIN",
  "MSTR", "BAC", "AMD", "INTC", "PLTR", "BABA", "DIS", "PYPL", "UBER", "SPY",
  "QQQ", "IWM", "DIA", "V", "MA", "JPM", "WMT", "XOM", "CVX", "LLY",
  "UNH", "JNJ", "AVGO", "ORCL", "CRM", "CSCO", "ABT", "MRK", "PEP", "KO",
  "COST", "TMO", "MCD", "NKE", "ABBV", "DHR", "TXN", "NEE", "PM", "QCOM",
  "HON", "UNP", "LIN", "BMY", "AMGN", "LOW", "IBM", "SBUX", "GE", "CAT",
  "BA", "GS", "MS", "BLK", "C", "WFC", "AXP", "SCHW", "HOOD", "RBLX",
  "ARM", "SMCI", "SOFI", "MARA", "RIOT", "CLSK", "HUT", "BITF", "CRCL",
  "TQQQ", "SQQQ", "SPXL", "SPXS", "SOXL", "SOXS"
];

const MULTIPLIER_PREFIXES = [
  { prefix: "1000000000", mult: 1000000000 },
  { prefix: "1000000", mult: 1000000 },
  { prefix: "100000", mult: 100000 },
  { prefix: "10000", mult: 10000 },
  { prefix: "1000", mult: 1000 },
  { prefix: "100", mult: 100 },
  { prefix: "10", mult: 10 },
  { prefix: "K1000000", mult: 1000000 },
  { prefix: "K1000", mult: 1000 },
];

const KNOWN_MEME_BASES = new Set([
  "PEPE", "SHIB", "BONK", "FLOKI", "LUNC", "MOG", "CAT", "NEIRO", "CHEEMS",
  "RATS", "SATS", "WHY", "BABYDOGE", "DOGS", "BTT", "XEC", "WIN", "HOT",
  "SPELL", "PEOPLE", "LADYS", "TURBO", "COQ", "WIF", "POPCAT", "MEW", "BRETT",
  "SUNDOG", "MOODENG", "GOAT", "PNUT", "ACT", "LUCE", "TOSHI", "DOGGO"
]);

function canonicalBase(ticker) {
  const symbol = String(ticker?.sym || "").toUpperCase().trim();
  if (/(?:USDT|USDC|USD)[_-]SPOT$/i.test(symbol) || symbol.endsWith("_SPOT") || symbol.endsWith("-SPOT")) return "";
  let raw = String(ticker?.base || symbol).toUpperCase().trim();
  raw = raw
    .replace(/^K?1000000(?=[A-Z])/, "1000000")
    .replace(/_SPOT$/i, "")
    .replace(/[-_.]?(USDTM|USDT|USDC|BUSD|USD)(?:[-_.]?(SWAP|PERP|PERPETUAL))?$/i, "")
    .replace(/[-_.]?(SWAP|PERP|PERPETUAL)$/i, "")
    .replace(/[^A-Z0-9]/g, "");

  if (raw.endsWith("STOCK")) raw = raw.replace(/STOCK$/, "");
  if ((raw.startsWith("R") || raw.startsWith("X")) && raw.length >= 4) raw = raw.slice(1);

  for (const root of STOCK_ROOTS_ARBITRAGE) {
    if (raw.startsWith(root) && raw.length <= root.length + 3) {
      const rem = raw.slice(root.length);
      if (["B", "X", "ON", "G", "M", "I", "STOCK", ""].includes(rem)) {
        raw = root;
        break;
      }
    }
  }

  return ALIASES[raw] || raw;
}

function extractBaseAndMultiplier(ticker) {
  const symbol = String(ticker?.sym || "").toUpperCase().trim();
  if (/(?:USDT|USDC|USD)[_-]SPOT$/i.test(symbol) || symbol.endsWith("_SPOT") || symbol.endsWith("-SPOT")) {
    return { base: "", multiplier: 1, rawBase: "" };
  }
  let raw = String(ticker?.base || symbol).toUpperCase().trim();
  raw = raw
    .replace(/_SPOT$/i, "")
    .replace(/[-_.]?(USDTM|USDT|USDC|BUSD|USD)(?:[-_.]?(SWAP|PERP|PERPETUAL))?$/i, "")
    .replace(/[-_.]?(SWAP|PERP|PERPETUAL)$/i, "")
    .replace(/[^A-Z0-9]/g, "");

  let mult = 1;

  for (const m of MULTIPLIER_PREFIXES) {
    if (raw.startsWith(m.prefix) && raw.length > m.prefix.length) {
      const rem = raw.slice(m.prefix.length);
      if (KNOWN_MEME_BASES.has(rem) || (rem.length >= 2 && !/^\d/.test(rem))) {
        mult = m.mult;
        raw = rem;
        break;
      }
    }
  }

  if (raw.startsWith("K") && raw.length >= 4) {
    const unk = raw.slice(1);
    if (KNOWN_MEME_BASES.has(unk)) {
      mult = 1000;
      raw = unk;
    }
  }

  if (raw.endsWith("STOCK")) raw = raw.replace(/STOCK$/, "");
  if ((raw.startsWith("R") || raw.startsWith("X")) && raw.length >= 4) {
    const unp = raw.slice(1);
    if (STOCK_ROOTS_ARBITRAGE.includes(unp)) raw = unp;
  }

  for (const root of STOCK_ROOTS_ARBITRAGE) {
    if (raw.startsWith(root) && raw.length <= root.length + 3) {
      const rem = raw.slice(root.length);
      if (["B", "X", "ON", "G", "M", "I", "STOCK", ""].includes(rem)) {
        raw = root;
        break;
      }
    }
  }

  return { base: ALIASES[raw] || raw, multiplier: mult, rawBase: ticker.base || ticker.sym };
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quoteFor(ticker, now) {
  const { base, multiplier, rawBase } = extractBaseAndMultiplier(ticker);
  if (!base) return null;

  const rawMid = finitePositive(ticker.p);
  const rawBid = finitePositive(ticker.bid) || rawMid;
  const rawAsk = finitePositive(ticker.ask) || rawMid;
  if (!rawMid || !rawBid || !rawAsk || rawAsk < rawBid * 0.90) return null;

  const quoteTs = Number(ticker.quoteTs) || now;
  const ageMs = Math.max(0, now - quoteTs);
  if (ageMs > 180000) return null; // 3m freshness

  const volume = finitePositive(ticker.v);
  // Exclude dead phantom markets with zero or sub-$1000 24h volume
  if (volume < 1000) return null;

  const factor = multiplier > 1 ? multiplier : 1;
  const mid = rawMid / factor;
  const bid = rawBid / factor;
  const ask = rawAsk / factor;

  return {
    ex: ticker.ex,
    sym: ticker.sym,
    rawBase,
    base,
    multiplier: factor,
    rawBid,
    rawAsk,
    rawMid,
    bid,
    ask,
    mid,
    volume,
    oi: finitePositive(ticker.oi),
    funding: Number.isFinite(Number(ticker.funding)) ? Number(ticker.funding) : 0,
    nextFunding: finitePositive(ticker.nextFunding),
    interval: finitePositive(ticker.fundingInterval) || EXCHANGES[ticker.ex]?.interval || 8,
    quoteTs,
    ageMs,
    executable: finitePositive(ticker.bid) > 0 && finitePositive(ticker.ask) > 0,
  };
}

function routeKey(type, base, longEx, shortEx) {
  return `${type}:${base}:${longEx}:${shortEx}`;
}

function tradeUrl(ex, sym) {
  const encoded = encodeURIComponent(sym);
  const urls = {
    BN: `https://www.binance.com/en/futures/${encoded}`,
    BB: `https://www.bybit.com/trade/usdt/${encoded}`,
    OX: `https://www.okx.com/trade-swap/${encoded.toLowerCase()}`,
    BG: `https://www.bitget.com/futures/usdt/${encoded}`,
    GT: `https://www.gate.com/futures/USDT/${encoded}`,
    MX: `https://futures.mexc.com/exchange/${encoded}`,
    KC: `https://www.kucoin.com/futures/trade/${encoded}`,
    BX: `https://bingx.com/en-us/perpetual/${encoded}`,
    HT: `https://www.htx.com/futures/linear_swap/exchange#contract_code=${encoded}`,
    HL: `https://app.hyperliquid.xyz/trade/${encoded}`,
    AD: `https://www.asterdex.com/en/futures/${encoded}`,
  };
  return urls[ex] || "#";
}

// Check if ratio between two prices represents an unhandled power-of-10 contract multiplier
function detectDynamicMultiplier(pA, pB) {
  if (pA <= 0 || pB <= 0) return 1;
  const rawRatio = pA / pB;
  const candidatePowers = [10, 100, 1000, 10000, 100000, 1000000, 1000000000];
  for (const pow of candidatePowers) {
    if (Math.abs(rawRatio - pow) / pow < 0.08) return pow;
    if (Math.abs(rawRatio - (1 / pow)) / (1 / pow) < 0.08) return 1 / pow;
  }
  return 1;
}

function buildRows(tickers, now = Date.now(), history = null) {
  const groups = new Map();
  const seenObjects = new Set();
  for (const ticker of tickers.values()) {
    if (!ticker || seenObjects.has(ticker) || !EXCHANGES[ticker.ex]) continue;
    seenObjects.add(ticker);
    const quote = quoteFor(ticker, now);
    if (!quote?.base) continue;
    if (!groups.has(quote.base)) groups.set(quote.base, new Map());
    const byExchange = groups.get(quote.base);
    const current = byExchange.get(quote.ex);
    if (!current ||
      (quote.executable && !current.executable) ||
      (quote.executable === current.executable && quote.ageMs < current.ageMs) ||
      (quote.executable === current.executable && quote.ageMs === current.ageMs && quote.volume > current.volume)) {
      byExchange.set(quote.ex, quote);
    }
  }

  const spreads = [];
  const funding = [];
  for (const [base, byExchange] of groups) {
    const quotes = [...byExchange.values()];
    if (quotes.length < 2) continue;
    for (let i = 0; i < quotes.length; i++) {
      for (let j = i + 1; j < quotes.length; j++) {
        let a = quotes[i];
        let b = quotes[j];

        // Auto-detect dynamic multiplier mismatch (e.g. 1000x on one venue)
        const dynMult = detectDynamicMultiplier(a.mid, b.mid);
        if (dynMult !== 1) {
          if (dynMult > 1) {
            a = { ...a, mid: a.mid / dynMult, bid: a.bid / dynMult, ask: a.ask / dynMult, multiplier: a.multiplier * dynMult };
          } else {
            const inv = 1 / dynMult;
            b = { ...b, mid: b.mid / inv, bid: b.bid / inv, ask: b.ask / inv, multiplier: b.multiplier * inv };
          }
        }

        const ratio = a.mid / b.mid;
        // In crypto arbitrage, genuine price ratio between venues for the same asset is tightly bounded
        if (ratio < 0.70 || ratio > 1.45) continue;

        const buy = a.ask <= b.ask ? a : b;
        const sell = a.ask <= b.ask ? b : a;
        if (sell.bid <= 0 || buy.ask <= 0) continue;

        const gross = ((sell.bid - buy.ask) / buy.ask) * 100;
        // Plausible gross spread range: -0.5% to +30% (spreads > 30% are ticker collisions on unverified tokens)
        if (gross < -0.5 || gross > 30) continue;

        const fee = (EXCHANGES[buy.ex]?.fee || 0.055) + (EXCHANGES[sell.ex]?.fee || 0.055);
        const net = gross - fee;
        const liquidity = Math.min(buy.volume || 0, sell.volume || 0);

        // Require minimum tradable liquidity ($5,000) to eliminate phantom zero-volume rows
        if (liquidity < 5000) continue;

        // If spread is abnormally high (>10%), require solid liquidity to filter out stale illiquid pairs
        if (gross > 10 && liquidity < 25000) continue;

        const freshness = Math.max(buy.ageMs, sell.ageMs);
        const quality = buy.executable && sell.executable ? "bbo" : "indicative";

        // Balanced Edge Score (0 - 100)
        const volBonus = Math.min(25, Math.max(0, Math.log10(liquidity / 1000)) * 6.5);
        const netBonus = Math.min(45, Math.max(0, net) * 15);
        const qualBonus = quality === "bbo" ? 10 : 0;
        const freshPenalty = Math.min(15, (freshness / 1000) * 1.2);
        const score = Math.max(5, Math.min(99,
          25 + netBonus + volBonus + qualBonus - freshPenalty
        ));

        const rKey = routeKey("spread", base, buy.ex, sell.ex);
        const histPoints = history ? (history.get(rKey) || []).slice(-30).map(pt => pt[1]) : [];

        spreads.push({
          key: rKey, base, symbol: `${base}/USDT`,
          buyEx: buy.ex, buyName: EXCHANGES[buy.ex].name, buySymbol: buy.sym,
          buyAsk: round(buy.rawAsk, 8), buyMultiplier: buy.multiplier,
          sellEx: sell.ex, sellName: EXCHANGES[sell.ex].name, sellSymbol: sell.sym,
          sellBid: round(sell.rawBid, 8), sellMultiplier: sell.multiplier,
          gross: round(gross, 4), fees: round(fee, 4), net: round(net, 4),
          liquidity: round(liquidity, 2), openInterest: round(Math.min(buy.oi || 0, sell.oi || 0), 2),
          buyFunding: round(buy.funding, 6), sellFunding: round(sell.funding, 6),
          buyInterval: buy.interval, sellInterval: sell.interval,
          ageMs: freshness, quality, score: round(score, 1),
          history: histPoints,
          buyUrl: tradeUrl(buy.ex, buy.sym), sellUrl: tradeUrl(sell.ex, sell.sym),
        });

        // Funding rate arbitrage comparison
        const long = a.funding / a.interval <= b.funding / b.interval ? a : b;
        const short = long === a ? b : a;
        const hourlyEdge = short.funding / short.interval - long.funding / long.interval;
        const daily = hourlyEdge * 24;
        const basis = ((short.mid - long.mid) / long.mid) * 100;

        // Discard absurd basis differences (>15%) which create uncontrollable price risk
        if (Math.abs(hourlyEdge) <= 1.5 && Math.abs(basis) <= 15) {
          const fundingLiquidity = Math.min(long.volume || 0, short.volume || 0);
          if (fundingLiquidity >= 5000) {
            const fundingVolBonus = Math.min(25, Math.max(0, Math.log10(fundingLiquidity / 1000)) * 6.5);
            const dailyBonus = Math.min(50, Math.max(0, daily) * 35);
            const basisPenalty = Math.min(20, Math.abs(basis) * 3.5);
            const fundingScore = Math.max(5, Math.min(99,
              25 + dailyBonus + fundingVolBonus + (long.executable && short.executable ? 8 : 0) - basisPenalty
            ));
            const fKey = routeKey("funding", base, long.ex, short.ex);
            const fHistPoints = history ? (history.get(fKey) || []).slice(-30).map(pt => pt[1]) : [];

            funding.push({
              key: fKey, base, symbol: `${base}/USDT`,
              longEx: long.ex, longName: EXCHANGES[long.ex].name, longSymbol: long.sym,
              longFunding: round(long.funding, 6), longInterval: long.interval,
              longPrice: round(long.rawMid, 8), longMultiplier: long.multiplier,
              shortEx: short.ex, shortName: EXCHANGES[short.ex].name, shortSymbol: short.sym,
              shortFunding: round(short.funding, 6), shortInterval: short.interval,
              shortPrice: round(short.rawMid, 8), shortMultiplier: short.multiplier,
              hourly: round(hourlyEdge, 6), daily: round(daily, 4), monthly: round(daily * 30, 3), apr: round(daily * 365, 2),
              basis: round(basis, 4), liquidity: round(fundingLiquidity, 2),
              openInterest: round(Math.min(long.oi || 0, short.oi || 0), 2),
              nextFunding: Math.min(long.nextFunding || Infinity, short.nextFunding || Infinity),
              ageMs: Math.max(long.ageMs, short.ageMs), quality: long.executable && short.executable ? "bbo" : "indicative",
              score: round(fundingScore, 1),
              history: fHistPoints,
              longUrl: tradeUrl(long.ex, long.sym), shortUrl: tradeUrl(short.ex, short.sym),
            });
          }
        }
      }
    }
  }

  // Sort by score (quality, volume and spread combined) and net yield
  spreads.sort((a, b) => b.score - a.score || b.net - a.net || b.liquidity - a.liquidity);
  funding.sort((a, b) => b.score - a.score || b.daily - a.daily || b.liquidity - a.liquidity);
  return { spreads, funding, groups: groups.size };
}

function createArbitrageEngine(tickers, exStatus) {
  let snapshot = { generatedAt: 0, spreads: [], funding: [], groups: 0 };
  const history = new Map();
  let timer = null;

  function record(key, ts, value, buyPrice = 0, sellPrice = 0, gross = 0) {
    const points = history.get(key) || [];
    points.push([ts, value, buyPrice, sellPrice, gross]);
    if (points.length > 900) points.splice(0, points.length - 900);
    history.set(key, points);
  }

  function refresh() {
    const generatedAt = Date.now();
    snapshot = { generatedAt, ...buildRows(tickers, generatedAt, history) };
    for (const row of snapshot.spreads.slice(0, 1500)) {
      record(row.key, generatedAt, row.net, row.buyAsk, row.sellBid, row.gross);
      // Bi-directional key for history query stability
      const altKey = `spread:${row.base}:${row.sellEx}:${row.buyEx}`;
      record(altKey, generatedAt, row.net, row.buyAsk, row.sellBid, row.gross);
    }
    for (const row of snapshot.funding.slice(0, 1500)) {
      record(row.key, generatedAt, row.daily, row.longPrice, row.shortPrice, row.basis);
      const altKey = `funding:${row.base}:${row.shortEx}:${row.longEx}`;
      record(altKey, generatedAt, row.daily, row.longPrice, row.shortPrice, row.basis);
    }
    for (const [key, points] of history) {
      if (!points.length || generatedAt - points[points.length - 1][0] > 7200000) history.delete(key);
    }
  }

  function getSnapshot() {
    if (!snapshot.generatedAt || Date.now() - snapshot.generatedAt > 3500) refresh();
    const statuses = {};
    for (const code of Object.keys(EXCHANGES)) {
      const state = exStatus.get(code);
      statuses[code] = { name: EXCHANGES[code].name, status: state?.status || "connecting", lastUpdate: state?.lastUpdate || 0 };
    }
    return { ...snapshot, exchanges: statuses, exchangeCount: Object.keys(EXCHANGES).length };
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, 2000);
    if (typeof timer.unref === "function") timer.unref();
  }

  function getOpportunity(key) {
    const wanted = String(key || "");
    return snapshot.spreads.find(row => row.key === wanted) || snapshot.funding.find(row => row.key === wanted) || null;
  }

  function getHistory(key) {
    const direct = history.get(String(key || ""));
    if (direct && direct.length) return direct;
    const parts = String(key || "").split(":");
    if (parts.length === 4) {
      const altKey = `${parts[0]}:${parts[1]}:${parts[3]}:${parts[2]}`;
      return history.get(altKey) || [];
    }
    return [];
  }

  return { start, refresh, getSnapshot, getOpportunity, getHistory };
}

module.exports = { EXCHANGES, canonicalBase, extractBaseAndMultiplier, buildRows, createArbitrageEngine };
