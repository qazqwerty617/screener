"use strict";

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeLevels(levels, multiplier = 1, descending = false) {
  const result = [];
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = positive(Array.isArray(level) ? level[0] : level?.p ?? level?.price ?? level?.px);
    const rawSize = positive(Array.isArray(level) ? level[1] : level?.s ?? level?.size ?? level?.sz ?? level?.vol ?? level?.quantity);
    const size = rawSize * positive(multiplier || 1);
    if (price && size) result.push([price, size]);
  }
  result.sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]);
  return result;
}

function fillQuantity(levels, requestedQty) {
  let left = Math.max(0, Number(requestedQty) || 0);
  let qty = 0;
  let value = 0;
  let levelsUsed = 0;
  for (const [price, available] of levels) {
    if (left <= 1e-14) break;
    const take = Math.min(left, available);
    qty += take;
    value += take * price;
    left -= take;
    levelsUsed++;
  }
  return { qty, value, avg: qty > 0 ? value / qty : 0, complete: left <= Math.max(1e-12, requestedQty * 1e-9), levelsUsed };
}

function capacityAtImpact(levels, side, impactPct) {
  if (!levels.length) return { qty: 0, notional: 0 };
  const top = levels[0][0];
  const limit = side === "buy" ? top * (1 + impactPct / 100) : top * (1 - impactPct / 100);
  let qty = 0;
  let value = 0;
  for (const [price, available] of levels) {
    const nextQty = qty + available;
    const nextValue = value + price * available;
    const nextAvg = nextValue / nextQty;
    const valid = side === "buy" ? nextAvg <= limit : nextAvg >= limit;
    if (valid) {
      qty = nextQty;
      value = nextValue;
      continue;
    }
    let partial = 0;
    if (side === "buy" && price > limit) partial = (limit * qty - value) / (price - limit);
    if (side === "sell" && price < limit) partial = (value - limit * qty) / (limit - price);
    partial = Math.max(0, Math.min(available, partial));
    qty += partial;
    value += partial * price;
    break;
  }
  return { qty, notional: qty * top };
}

function analyzeBooks({ asks, bids, notional, feesPct = 0, fundingDailyPct = 0 }) {
  if (!asks.length || !bids.length) throw new Error("Order book is empty");
  const buyTop = asks[0][0];
  const sellTop = bids[0][0];
  const requestedQty = Math.max(1, Number(notional) || 500) / buyTop;
  const buyProbe = fillQuantity(asks, requestedQty);
  const sellProbe = fillQuantity(bids, requestedQty);
  const executableQty = Math.min(buyProbe.qty, sellProbe.qty);
  const buy = fillQuantity(asks, executableQty);
  const sell = fillQuantity(bids, executableQty);
  const grossPct = buy.avg > 0 ? ((sell.avg - buy.avg) / buy.avg) * 100 : 0;
  const netPct = grossPct - feesPct;
  const impactBuyPct = buyTop > 0 ? ((buy.avg - buyTop) / buyTop) * 100 : 0;
  const impactSellPct = sellTop > 0 ? ((sellTop - sell.avg) / sellTop) * 100 : 0;
  const bands = [0.05, 0.1, 0.25, 0.5, 1].map(impact => {
    const buyCapacity = capacityAtImpact(asks, "buy", impact);
    const sellCapacity = capacityAtImpact(bids, "sell", impact);
    return { impact, notional: Math.min(buyCapacity.notional, sellCapacity.notional) };
  });
  return {
    requestedNotional: Number(notional) || 500,
    executableNotional: executableQty * buy.avg,
    executableQty,
    complete: buyProbe.complete && sellProbe.complete,
    buy: { top: buyTop, average: buy.avg, impactPct: impactBuyPct, levelsUsed: buy.levelsUsed },
    sell: { top: sellTop, average: sell.avg, impactPct: impactSellPct, levelsUsed: sell.levelsUsed },
    grossPct,
    feesPct,
    netPct,
    fundingDailyPct,
    netAfterFundingDayPct: netPct + fundingDailyPct,
    estimatedPnl: executableQty * buy.avg * netPct / 100,
    estimatedPnlAfterFundingDay: executableQty * buy.avg * (netPct + fundingDailyPct) / 100,
    bands,
  };
}

function createDepthAnalyzer(apiFetch, tickers, arbitrageEngine) {
  const cache = new Map();

  function findTicker(ex, sym) {
    return tickers.get(`${ex}:${sym}`) || [...tickers.values()].find(t => t.ex === ex && t.sym === sym);
  }

  async function fetchBook(ex, sym) {
    const key = `${ex}:${sym}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < 2500) return cached.book;
    const ticker = findTicker(ex, sym);
    const cs = positive(ticker?.cs) || 1;
    const s = encodeURIComponent(sym);
    let raw;
    let bids;
    let asks;
    if (ex === "BN" || ex === "AD") {
      const host = ex === "BN" ? "fapi.binance.com" : "fapi.asterdex.com";
      raw = await apiFetch(`https://${host}/fapi/v1/depth?symbol=${s}&limit=500`, 7000, 1);
      bids = raw.bids; asks = raw.asks;
    } else if (ex === "BB") {
      raw = await apiFetch(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${s}&limit=500`, 7000, 1);
      bids = raw.result?.b; asks = raw.result?.a;
    } else if (ex === "OX") {
      raw = await apiFetch(`https://www.okx.com/api/v5/market/books?instId=${s}&sz=400`, 7000, 1);
      bids = raw.data?.[0]?.bids; asks = raw.data?.[0]?.asks;
    } else if (ex === "BG") {
      raw = await apiFetch(`https://api.bitget.com/api/v2/mix/market/merge-depth?productType=USDT-FUTURES&symbol=${s}&precision=scale0&limit=100`, 7000, 1);
      bids = raw.data?.bids; asks = raw.data?.asks;
    } else if (ex === "GT") {
      raw = await apiFetch(`https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${s}&limit=100&with_id=true`, 7000, 1);
      bids = raw.bids; asks = raw.asks;
    } else if (ex === "MX") {
      raw = await apiFetch(`https://contract.mexc.com/api/v1/contract/depth/${s}?limit=100`, 7000, 1);
      bids = raw.data?.bids; asks = raw.data?.asks;
    } else if (ex === "KC") {
      raw = await apiFetch(`https://api-futures.kucoin.com/api/v1/level2/depth100?symbol=${s}`, 7000, 1);
      bids = raw.data?.bids; asks = raw.data?.asks;
    } else if (ex === "BX") {
      raw = await apiFetch(`https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${s}&limit=100`, 7000, 1);
      bids = raw.data?.bids; asks = raw.data?.asks;
    } else if (ex === "HT") {
      raw = await apiFetch(`https://api.hbdm.vn/linear-swap-ex/market/depth?contract_code=${s}&type=step0`, 7000, 1);
      bids = raw.tick?.bids; asks = raw.tick?.asks;
    } else if (ex === "HL") {
      raw = await apiFetch("https://api.hyperliquid.xyz/info", 7000, 1, "POST", { type: "l2Book", coin: sym });
      bids = raw.levels?.[0]; asks = raw.levels?.[1];
    } else {
      throw new Error("Unsupported exchange order book");
    }
    const book = {
      ex, sym, ts: Date.now(),
      bids: normalizeLevels(bids, cs, true),
      asks: normalizeLevels(asks, cs, false),
    };
    if (!book.bids.length || !book.asks.length) throw new Error(`${ex} returned an empty order book`);
    cache.set(key, { ts: Date.now(), book });
    return book;
  }

  async function analyze(key, notional) {
    const row = arbitrageEngine.getOpportunity(key);
    if (!row || !String(key).startsWith("spread:")) throw new Error("Spread opportunity not found");
    const [buyBook, sellBook] = await Promise.all([
      fetchBook(row.buyEx, row.buySymbol),
      fetchBook(row.sellEx, row.sellSymbol),
    ]);
    const fundingDailyPct = (row.sellFunding / (row.sellInterval || 8) - row.buyFunding / (row.buyInterval || 8)) * 24;
    return {
      key,
      generatedAt: Date.now(),
      buyEx: row.buyEx,
      sellEx: row.sellEx,
      ...analyzeBooks({ asks: buyBook.asks, bids: sellBook.bids, notional, feesPct: row.fees, fundingDailyPct }),
    };
  }

  return { analyze, fetchBook };
}

module.exports = { normalizeLevels, fillQuantity, capacityAtImpact, analyzeBooks, createDepthAnalyzer };
