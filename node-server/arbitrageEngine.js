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
const MAX_EXECUTABLE_AGE_MS = 30000;
const MAX_FUNDING_MARKET_AGE_MS = 3 * 60000;
const FUNDING_EVENT_SYNC_MS = 5 * 60000;
const MAX_FUNDING_EVENT_AHEAD_MS = 24 * 60 * 60000;

const STOCK_ROOTS_ARBITRAGE = [
  "AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOG", "GOOGL", "META", "NFLX", "COIN",
  "MSTR", "BAC", "AMD", "INTC", "PLTR", "BABA", "DIS", "PYPL", "UBER", "SPY",
  "QQQ", "IWM", "DIA", "V", "MA", "JPM", "WMT", "XOM", "CVX", "LLY",
  "UNH", "JNJ", "AVGO", "ORCL", "CRM", "CSCO", "ABT", "MRK", "PEP", "KO",
  "COST", "TMO", "MCD", "NKE", "ABBV", "DHR", "TXN", "NEE", "PM", "QCOM",
  "HON", "UNP", "LIN", "BMY", "AMGN", "LOW", "IBM", "SBUX", "GE", "CAT",
  "BA", "GS", "MS", "BLK", "C", "WFC", "AXP", "SCHW", "HOOD", "RBLX",
  "ARM", "SMCI", "SOFI", "MARA", "RIOT", "CLSK", "HUT", "BITF", "CRCL",
  "TQQQ", "SQQQ", "SPXL", "SPXS", "SOXL", "SOXS",
  "SAMSUNG", "ANTHROPIC", "OPENAI", "SPACEX", "SPCX", "UNITREE", "FIGMA", "STRIPE",
  "SKHYNIX", "SKHY", "SNDK", "DELL", "RKLB", "AAOI", "MRVL", "NBIS", "CXMT",
  "XIAOMI", "TENCENT", "ALIBABA", "SONY", "TOYOTA", "NIO"
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

function quoteFor(ticker, now, excludedBases = null) {
  const { base, multiplier, rawBase } = extractBaseAndMultiplier(ticker);
  if (!base) return null;
  if (ticker?.isRwa === true || String(ticker?.isRwa || "").toUpperCase() === "YES" || STOCK_ROOTS_ARBITRAGE.includes(base) || excludedBases?.has(base)) return null;

  const rawMid = finitePositive(ticker.p);
  const rawBid = finitePositive(ticker.bid);
  const rawAsk = finitePositive(ticker.ask);
  if (!rawMid || (rawBid && rawAsk && rawAsk < rawBid * 0.90)) return null;

  const quoteTs = finitePositive(ticker.quoteTs);
  const ageMs = quoteTs ? Math.max(0, now - quoteTs) : Infinity;

  const volume = finitePositive(ticker.v);
  // Exclude dead phantom markets with zero or sub-$1000 24h volume
  if (volume < 1000) return null;

  const factor = multiplier > 1 ? multiplier : 1;
  const mid = rawMid / factor;
  const bid = rawBid ? rawBid / factor : 0;
  const ask = rawAsk ? rawAsk / factor : 0;

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
    takerFee: finitePositive(ticker.takerFeePct) || EXCHANGES[ticker.ex]?.fee || 0.055,
    quoteTs,
    ageMs,
    marketFresh: quoteTs > 0 && ageMs <= MAX_FUNDING_MARKET_AGE_MS,
    executable: rawBid > 0 && rawAsk > 0 && quoteTs > 0 && ageMs <= MAX_EXECUTABLE_AGE_MS,
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

function spreadSample(base, buy, sell) {
  if (!buy?.executable || !sell?.executable || !buy.ask || !buy.bid || !sell.ask || !sell.bid) return null;
  const gross = ((sell.bid - buy.ask) / buy.ask) * 100;
  const exitGross = ((buy.bid - sell.ask) / sell.ask) * 100;
  const fees = buy.takerFee + sell.takerFee;
  return {
    key: routeKey("spread", base, buy.ex, sell.ex),
    base,
    buy,
    sell,
    gross,
    net: gross - fees,
    exitGross,
    exitNet: exitGross - fees,
    fees,
  };
}

function nextFundingEvent(long, short, now) {
  const deadline = now + MAX_FUNDING_EVENT_AHEAD_MS;
  const longAt = long.nextFunding > now && long.nextFunding <= deadline ? long.nextFunding : 0;
  const shortAt = short.nextFunding > now && short.nextFunding <= deadline ? short.nextFunding : 0;
  if (!longAt && !shortAt) return { at: 0, edge: null, legs: "unknown" };
  if (longAt && shortAt && Math.abs(longAt - shortAt) <= FUNDING_EVENT_SYNC_MS) {
    return { at: Math.max(longAt, shortAt), edge: -long.funding + short.funding, legs: "both" };
  }
  if (longAt && (!shortAt || longAt < shortAt)) return { at: longAt, edge: -long.funding, legs: "long" };
  return { at: shortAt, edge: short.funding, legs: "short" };
}

// Check if ratio between two prices represents an unhandled power-of-10 contract multiplier
function detectDynamicMultiplier(pA, pB) {
  if (pA <= 0 || pB <= 0) return 1;
  const rawRatio = pA / pB;
  const candidatePowers = [10, 100, 1000, 10000, 100000, 1000000, 1000000000];
  for (const pow of candidatePowers) {
    if (Math.abs(rawRatio - pow) / pow < 0.015) return pow;
    if (Math.abs(rawRatio - (1 / pow)) / (1 / pow) < 0.015) return 1 / pow;
  }
  return 1;
}

function buildRows(tickers, now = Date.now(), history = null, onRouteSample = null, assetAllowed = null) {
  const groups = new Map();
  const seenObjects = new Set();
  const excludedBases = new Set(STOCK_ROOTS_ARBITRAGE);
  for (const ticker of tickers.values()) {
    if (ticker?.isRwa === true || String(ticker?.isRwa || "").toUpperCase() === "YES") {
      const { base } = extractBaseAndMultiplier(ticker);
      if (base) excludedBases.add(base);
    }
  }
  for (const ticker of tickers.values()) {
    if (!ticker || seenObjects.has(ticker) || !EXCHANGES[ticker.ex]) continue;
    seenObjects.add(ticker);
    const quote = quoteFor(ticker, now, excludedBases);
    if (!quote?.base) continue;
    if (typeof assetAllowed === "function" && !assetAllowed(quote.base, ticker)) continue;
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

        const routeAB = spreadSample(base, a, b);
        const routeBA = spreadSample(base, b, a);
        if (routeAB && routeBA) {
          if (typeof onRouteSample === "function") {
            onRouteSample(routeAB);
            onRouteSample(routeBA);
          }
          const selected = routeAB.net >= routeBA.net ? routeAB : routeBA;
          const { buy, sell, gross, net, exitGross, exitNet, fees: fee } = selected;
          const liquidity = Math.min(buy.volume || 0, sell.volume || 0);

          // Keep only plausible, liquid routes; the public endpoint applies the user's minimum edge.
          if (gross >= -0.5 && gross <= 30 && liquidity >= 5000 && !(gross > 10 && liquidity < 25000)) {
            const freshness = Math.max(buy.ageMs, sell.ageMs);
            const roundTripFees = fee * 2;
            const roundTripNet = gross - roundTripFees;
            const closeNowNet = gross + exitGross - roundTripFees;
            const buyBookWidth = ((buy.ask - buy.bid) / buy.mid) * 100;
            const sellBookWidth = ((sell.ask - sell.bid) / sell.mid) * 100;
            const volBonus = Math.min(25, Math.max(0, Math.log10(liquidity / 1000)) * 6.5);
            const netBonus = Math.min(45, Math.max(0, roundTripNet) * 15);
            const freshPenalty = Math.min(18, (freshness / 1000) * 0.6);
            const bookPenalty = Math.min(20, Math.max(0, buyBookWidth + sellBookWidth) * 6);
            const score = Math.max(5, Math.min(99, 30 + netBonus + volBonus - freshPenalty - bookPenalty));
            const rKey = routeKey("spread", base, buy.ex, sell.ex);

            spreads.push({
              key: rKey, base, symbol: `${base}/USDT`,
              buyEx: buy.ex, buyName: EXCHANGES[buy.ex].name, buySymbol: buy.sym,
              buyAsk: round(buy.rawAsk, 8), buyBid: round(buy.rawBid, 8), buyMultiplier: buy.multiplier,
              sellEx: sell.ex, sellName: EXCHANGES[sell.ex].name, sellSymbol: sell.sym,
              sellBid: round(sell.rawBid, 8), sellAsk: round(sell.rawAsk, 8), sellMultiplier: sell.multiplier,
              gross: round(gross, 4), fees: round(fee, 4), net: round(net, 4),
              roundTripFees: round(roundTripFees, 4), roundTripNet: round(roundTripNet, 4),
              exitGross: round(exitGross, 4), exitNet: round(exitNet, 4), closeNowNet: round(closeNowNet, 4),
              liquidity: round(liquidity, 2), openInterest: round(Math.min(buy.oi || 0, sell.oi || 0), 2),
              buyFunding: round(buy.funding, 6), sellFunding: round(sell.funding, 6),
              buyInterval: buy.interval, sellInterval: sell.interval,
              ageMs: freshness, quality: "bbo", score: round(score, 1),
              history: [],
              buyUrl: tradeUrl(buy.ex, buy.sym), sellUrl: tradeUrl(sell.ex, sell.sym),
            });
          }
        }

        // Funding rate arbitrage comparison
        const long = a.funding / a.interval <= b.funding / b.interval ? a : b;
        const short = long === a ? b : a;
        const hourlyEdge = short.funding / short.interval - long.funding / long.interval;
        const basis = ((short.mid - long.mid) / long.mid) * 100;

        // Discard absurd basis differences (>15%) which create uncontrollable price risk
        if (long.marketFresh && short.marketFresh && hourlyEdge > 0 && Math.abs(hourlyEdge) <= 1.5 && Math.abs(basis) <= 15) {
          const fundingLiquidity = Math.min(long.volume || 0, short.volume || 0);
          if (fundingLiquidity >= 5000) {
            const event = nextFundingEvent(long, short, now);
            if (!event.at || !Number.isFinite(event.edge)) continue;
            const roundTripFees = 2 * (long.takerFee + short.takerFee);
            const breakEvenHours = hourlyEdge > 0 ? roundTripFees / hourlyEdge : Infinity;
            const fundingVolBonus = Math.min(25, Math.max(0, Math.log10(fundingLiquidity / 1000)) * 6.5);
            const hourlyBonus = Math.min(40, hourlyEdge * 400);
            const eventBonus = Math.min(18, Math.max(0, event.edge || 0) * 60);
            const basisPenalty = Math.min(20, Math.abs(basis) * 3.5);
            const paybackPenalty = Math.min(18, breakEvenHours / 24);
            const freshnessPenalty = Math.min(12, Math.max(long.ageMs, short.ageMs) / 15000);
            const fundingScore = Math.max(5, Math.min(99,
              24 + hourlyBonus + eventBonus + fundingVolBonus + (long.executable && short.executable ? 8 : 0) - basisPenalty - paybackPenalty - freshnessPenalty
            ));
            const fKey = routeKey("funding", base, long.ex, short.ex);

            funding.push({
              key: fKey, base, symbol: `${base}/USDT`,
              longEx: long.ex, longName: EXCHANGES[long.ex].name, longSymbol: long.sym,
              longFunding: round(long.funding, 6), longInterval: long.interval,
              longPrice: round(long.rawMid, 8), longMultiplier: long.multiplier,
              shortEx: short.ex, shortName: EXCHANGES[short.ex].name, shortSymbol: short.sym,
              shortFunding: round(short.funding, 6), shortInterval: short.interval,
              shortPrice: round(short.rawMid, 8), shortMultiplier: short.multiplier,
              hourly: round(hourlyEdge, 6),
              longNextFunding: long.nextFunding || 0, shortNextFunding: short.nextFunding || 0,
              nextEventAt: event.at, nextEventEdge: event.edge == null ? null : round(event.edge, 6), nextEventLegs: event.legs,
              roundTripFees: round(roundTripFees, 4), breakEvenHours: round(breakEvenHours, 2),
              basis: round(basis, 4), liquidity: round(fundingLiquidity, 2),
              openInterest: round(Math.min(long.oi || 0, short.oi || 0), 2),
              nextFunding: event.at,
              ageMs: Math.max(long.ageMs, short.ageMs), quality: long.executable && short.executable ? "bbo" : "indicative",
              score: round(fundingScore, 1),
              history: [],
              longUrl: tradeUrl(long.ex, long.sym), shortUrl: tradeUrl(short.ex, short.sym),
            });
          }
        }
      }
    }
  }

  // Sort by score (quality, volume and spread combined) and net yield
  spreads.sort((a, b) => b.score - a.score || b.roundTripNet - a.roundTripNet || b.liquidity - a.liquidity);
  funding.sort((a, b) => b.score - a.score || (b.nextEventEdge || 0) - (a.nextEventEdge || 0) || b.hourly - a.hourly || b.liquidity - a.liquidity);

  // Attach sparkline points only for top active rows to avoid memory churn
  if (history) {
    for (const row of spreads.slice(0, 150)) {
      row.history = (history.get(row.key) || []).slice(-30).map(pt => pt[1]);
    }
    for (const row of funding.slice(0, 150)) {
      row.history = (history.get(row.key) || []).slice(-30).map(pt => pt[1]);
    }
  }

  return { spreads, funding, groups: groups.size };
}

function createArbitrageEngine(tickers, exStatus, options = {}) {
  let snapshot = { generatedAt: 0, spreads: [], funding: [], groups: 0 };
  const history = new Map();
  const watchedRoutes = new Map();
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const rankedHistoryLimit = Math.max(0, Number.isFinite(options.rankedHistoryLimit) ? options.rankedHistoryLimit : 200);
  const historyLimit = Math.max(90, Number.isFinite(options.historyLimit) ? options.historyLimit : 2160);
  let timer = null;

  function record(key, ts, value, buyPrice = 0, sellPrice = 0, gross = 0, exit = 0, buyExit = 0, sellExit = 0) {
    const points = history.get(key) || [];
    const previous = points[points.length - 1];
    if (previous?.[0] === ts) return;
    points.push([ts, value, buyPrice, sellPrice, gross, exit, buyExit, sellExit]);
    if (points.length > historyLimit) points.splice(0, points.length - historyLimit);
    history.set(key, points);
  }

  function refresh() {
    const generatedAt = clock();
    const watchedSamples = new Map();
    const rows = buildRows(tickers, generatedAt, history, sample => {
      if (watchedRoutes.has(sample.key)) watchedSamples.set(sample.key, sample);
    }, options.assetAllowed);
    snapshot = { generatedAt, ...rows };
    for (const row of snapshot.spreads.slice(0, rankedHistoryLimit)) {
      record(row.key, generatedAt, row.net, row.buyAsk, row.sellBid, row.gross, row.exitNet, row.buyBid, row.sellAsk);
    }
    for (const sample of watchedSamples.values()) {
      record(
        sample.key,
        generatedAt,
        round(sample.net, 4),
        round(sample.buy.rawAsk, 8),
        round(sample.sell.rawBid, 8),
        round(sample.gross, 4),
        round(sample.exitNet, 4),
        round(sample.buy.rawBid, 8),
        round(sample.sell.rawAsk, 8),
      );
    }
    for (const row of snapshot.funding.slice(0, rankedHistoryLimit)) {
      record(row.key, generatedAt, row.hourly, row.longPrice, row.shortPrice, row.basis);
    }
    for (const [key, points] of history) {
      if (!points.length || generatedAt - points[points.length - 1][0] > 12 * 3600000) history.delete(key);
    }
    for (const [key, touchedAt] of watchedRoutes) {
      if (generatedAt - touchedAt > 15 * 60000) watchedRoutes.delete(key);
    }
  }

  function getSnapshot() {
    if (!snapshot.generatedAt || Date.now() - snapshot.generatedAt > 6000) refresh();
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
    timer = setInterval(refresh, 5000);
    if (typeof timer.unref === "function") timer.unref();
  }

  function getOpportunity(key) {
    const wanted = String(key || "");
    return snapshot.spreads.find(row => row.key === wanted) || snapshot.funding.find(row => row.key === wanted) || null;
  }

  function getHistory(key) {
    const wanted = String(key || "");
    watchedRoutes.set(wanted, clock());
    return history.get(wanted) || [];
  }

  return { start, refresh, getSnapshot, getOpportunity, getHistory };
}

module.exports = { EXCHANGES, canonicalBase, extractBaseAndMultiplier, buildRows, createArbitrageEngine };
