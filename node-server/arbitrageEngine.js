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

const ALIASES = Object.freeze({ XBT: "BTC", XDG: "DOGE" });

function canonicalBase(ticker) {
  const symbol = String(ticker?.sym || "").toUpperCase().trim();
  if (/(?:USDT|USDC|USD)[_-]SPOT$/.test(symbol)) return "";
  let raw = String(ticker?.base || symbol).toUpperCase().trim();
  raw = raw
    .replace(/^K?1000000(?=[A-Z])/, "1000000")
    .replace(/[-_.]?(USDTM|USDT|USDC|BUSD|USD)(?:[-_.]?(SWAP|PERP|PERPETUAL))?$/i, "")
    .replace(/[-_.]?(SWAP|PERP|PERPETUAL)$/i, "")
    .replace(/[^A-Z0-9]/g, "");
  return ALIASES[raw] || raw;
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
  const mid = finitePositive(ticker.p);
  const bid = finitePositive(ticker.bid) || mid;
  const ask = finitePositive(ticker.ask) || mid;
  if (!mid || !bid || !ask || ask < bid * 0.98) return null;
  const quoteTs = Number(ticker.quoteTs) || now;
  return {
    ex: ticker.ex,
    sym: ticker.sym,
    base: canonicalBase(ticker),
    bid,
    ask,
    mid,
    volume: finitePositive(ticker.v),
    oi: finitePositive(ticker.oi),
    funding: Number.isFinite(Number(ticker.funding)) ? Number(ticker.funding) : 0,
    nextFunding: finitePositive(ticker.nextFunding),
    interval: finitePositive(ticker.fundingInterval) || EXCHANGES[ticker.ex]?.interval || 8,
    quoteTs,
    ageMs: Math.max(0, now - quoteTs),
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

function buildRows(tickers, now = Date.now()) {
  const groups = new Map();
  const seenObjects = new Set();
  for (const ticker of tickers.values()) {
    if (!ticker || seenObjects.has(ticker) || !EXCHANGES[ticker.ex]) continue;
    seenObjects.add(ticker);
    const quote = quoteFor(ticker, now);
    if (!quote?.base || quote.ageMs > 120000) continue;
    if (!groups.has(quote.base)) groups.set(quote.base, new Map());
    const byExchange = groups.get(quote.base);
    const current = byExchange.get(quote.ex);
    if (!current || quote.volume > current.volume) byExchange.set(quote.ex, quote);
  }

  const spreads = [];
  const funding = [];
  for (const [base, byExchange] of groups) {
    const quotes = [...byExchange.values()];
    if (quotes.length < 2) continue;
    for (let i = 0; i < quotes.length; i++) {
      for (let j = i + 1; j < quotes.length; j++) {
        const a = quotes[i];
        const b = quotes[j];
        const ratio = a.mid / b.mid;
        if (ratio < 0.5 || ratio > 2) continue;

        const buy = a.ask <= b.ask ? a : b;
        const sell = a.ask <= b.ask ? b : a;
        if (sell.bid <= 0 || buy.ask <= 0) continue;
        const gross = ((sell.bid - buy.ask) / buy.ask) * 100;
        if (gross < -0.5 || gross > 20) continue;
        const fee = (EXCHANGES[buy.ex]?.fee || 0.06) + (EXCHANGES[sell.ex]?.fee || 0.06);
        const net = gross - fee;
        const liquidity = Math.min(buy.volume || 0, sell.volume || 0);
        const freshness = Math.max(buy.ageMs, sell.ageMs);
        const quality = buy.executable && sell.executable ? "bbo" : "indicative";
        const score = Math.max(0, Math.min(100,
          38 + net * 18 + Math.log10(Math.max(1, liquidity)) * 4 - freshness / 1500 - (quality === "bbo" ? 0 : 16)
        ));
        spreads.push({
          key: routeKey("spread", base, buy.ex, sell.ex), base, symbol: `${base}/USDT`,
          buyEx: buy.ex, buyName: EXCHANGES[buy.ex].name, buySymbol: buy.sym, buyAsk: round(buy.ask, 10),
          sellEx: sell.ex, sellName: EXCHANGES[sell.ex].name, sellSymbol: sell.sym, sellBid: round(sell.bid, 10),
          gross: round(gross, 4), fees: round(fee, 4), net: round(net, 4),
          liquidity: round(liquidity, 2), openInterest: round(Math.min(buy.oi || 0, sell.oi || 0), 2),
          buyFunding: round(buy.funding, 6), sellFunding: round(sell.funding, 6),
          buyInterval: buy.interval, sellInterval: sell.interval,
          ageMs: freshness, quality, score: round(score, 1),
          buyUrl: tradeUrl(buy.ex, buy.sym), sellUrl: tradeUrl(sell.ex, sell.sym),
        });

        const long = a.funding / a.interval <= b.funding / b.interval ? a : b;
        const short = long === a ? b : a;
        const hourlyEdge = short.funding / short.interval - long.funding / long.interval;
        const daily = hourlyEdge * 24;
        const basis = ((short.mid - long.mid) / long.mid) * 100;
        if (Math.abs(hourlyEdge) <= 2 || Math.abs(basis) <= 20) {
          const fundingLiquidity = Math.min(long.volume || 0, short.volume || 0);
          const fundingScore = Math.max(0, Math.min(100,
            35 + daily * 28 + Math.log10(Math.max(1, fundingLiquidity)) * 4 - Math.abs(basis) * 4
          ));
          funding.push({
            key: routeKey("funding", base, long.ex, short.ex), base, symbol: `${base}/USDT`,
            longEx: long.ex, longName: EXCHANGES[long.ex].name, longSymbol: long.sym, longFunding: round(long.funding, 6), longInterval: long.interval,
            longPrice: round(long.mid, 10),
            shortEx: short.ex, shortName: EXCHANGES[short.ex].name, shortSymbol: short.sym, shortFunding: round(short.funding, 6), shortInterval: short.interval,
            shortPrice: round(short.mid, 10),
            hourly: round(hourlyEdge, 6), daily: round(daily, 4), monthly: round(daily * 30, 3), apr: round(daily * 365, 2),
            basis: round(basis, 4), liquidity: round(fundingLiquidity, 2),
            openInterest: round(Math.min(long.oi || 0, short.oi || 0), 2),
            nextFunding: Math.min(long.nextFunding || Infinity, short.nextFunding || Infinity),
            ageMs: Math.max(long.ageMs, short.ageMs), quality: long.executable && short.executable ? "bbo" : "indicative",
            score: round(fundingScore, 1), longUrl: tradeUrl(long.ex, long.sym), shortUrl: tradeUrl(short.ex, short.sym),
          });
        }
      }
    }
  }
  spreads.sort((a, b) => b.net - a.net || b.liquidity - a.liquidity);
  funding.sort((a, b) => b.daily - a.daily || b.liquidity - a.liquidity);
  return { spreads, funding, groups: groups.size };
}

function createArbitrageEngine(tickers, exStatus) {
  let snapshot = { generatedAt: 0, spreads: [], funding: [], groups: 0 };
  const history = new Map();
  let timer = null;

  function refresh() {
    const generatedAt = Date.now();
    snapshot = { generatedAt, ...buildRows(tickers, generatedAt) };
    for (const row of snapshot.spreads.slice(0, 600)) record(row.key, generatedAt, row.net);
    for (const row of snapshot.funding.slice(0, 600)) record(row.key, generatedAt, row.daily);
    for (const [key, points] of history) {
      if (!points.length || generatedAt - points[points.length - 1][0] > 3600000) history.delete(key);
    }
  }

  function record(key, ts, value) {
    const points = history.get(key) || [];
    points.push([ts, value]);
    if (points.length > 900) points.splice(0, points.length - 900);
    history.set(key, points);
  }

  function getSnapshot() {
    if (!snapshot.generatedAt || Date.now() - snapshot.generatedAt > 4000) refresh();
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

  return { start, refresh, getSnapshot, getOpportunity, getHistory: key => history.get(String(key || "")) || [] };
}

module.exports = { EXCHANGES, canonicalBase, buildRows, createArbitrageEngine };
