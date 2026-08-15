"use strict";

const crypto = require("crypto");
const { aggregateExecutionsIntoTrades, normalizeExecution } = require("./journalAggregator");

function hmacHex(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Exchange HTTP ${response.status}`);
  return data;
}

async function fetchBybit(apiKey, apiSecret) {
  const executions = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const query = `category=linear&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const signature = hmacHex(apiSecret, timestamp + apiKey + recvWindow + query);
    const data = await fetchJson(`https://api.bybit.com/v5/execution/list?${query}`, { headers: {
      "X-BAPI-API-KEY": apiKey, "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow,
    }});
    if (data.retCode !== 0) throw new Error(`Bybit API (${data.retCode}): ${data.retMsg}`);
    const list = data.result?.list || [];
    for (const item of list) executions.push({
      id: item.execId, orderId: item.orderId, exchange: "Bybit", symbol: item.symbol,
      side: item.side, positionSide: item.positionSide || "BOTH", price: item.execPrice,
      qty: item.execQty, realizedPnl: item.execPnl, fee: item.execFee, time: item.execTime,
    });
    cursor = String(data.result?.nextPageCursor || "");
    if (!cursor || list.length < 100) break;
  }
  return executions;
}

async function fetchBinance(apiKey, apiSecret) {
  const query = `limit=1000&recvWindow=5000&timestamp=${Date.now()}`;
  const signature = hmacHex(apiSecret, query);
  const data = await fetchJson(`https://fapi.binance.com/fapi/v1/userTrades?${query}&signature=${signature}`, { headers: { "X-MBX-APIKEY": apiKey } });
  if (!Array.isArray(data)) throw new Error(`Binance API (${data.code || "API"}): ${data.msg || "invalid response"}`);
  return data.map(item => ({
    id: String(item.id), orderId: String(item.orderId || ""), exchange: "Binance", symbol: item.symbol,
    side: item.side, positionSide: item.positionSide || "BOTH", price: item.price, qty: item.qty,
    realizedPnl: item.realizedPnl, fee: item.commission, time: item.time,
  }));
}

async function fetchOkx(apiKey, apiSecret, passphrase) {
  const executions = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const timestamp = new Date().toISOString();
    const requestPath = `/api/v5/trade/fills-history?instType=SWAP&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const signature = crypto.createHmac("sha256", apiSecret).update(timestamp + "GET" + requestPath).digest("base64");
    const data = await fetchJson(`https://www.okx.com${requestPath}`, { headers: {
      "OK-ACCESS-KEY": apiKey, "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": passphrase,
    }});
    if (data.code !== "0") throw new Error(`OKX API (${data.code}): ${data.msg}`);
    const list = data.data || [];
    for (const item of list) executions.push({
      id: item.tradeId || item.fillId, orderId: item.ordId, exchange: "OKX",
      symbol: String(item.instId || "").replace("-SWAP", "").replaceAll("-", ""),
      side: item.side, positionSide: item.posSide || "BOTH", price: item.fillPx,
      qty: item.fillSz, realizedPnl: item.fillPnl, fee: item.fillFee || item.fee,
      time: item.fillTime || item.ts,
    });
    after = String(list[list.length - 1]?.tradeId || list[list.length - 1]?.fillId || "");
    if (!after || list.length < 100) break;
  }
  return executions;
}

async function syncJournal({ exchange, apiKey, apiSecret, passphrase }) {
  let executions;
  if (exchange === "BB" || exchange === "Bybit") executions = await fetchBybit(apiKey, apiSecret);
  else if (exchange === "BN" || exchange === "Binance") executions = await fetchBinance(apiKey, apiSecret);
  else if (exchange === "OX" || exchange === "OKX") executions = await fetchOkx(apiKey, apiSecret, passphrase);
  else throw new Error("Эта биржа пока не поддерживает безопасную синхронизацию журнала");
  const items = executions.map(normalizeExecution)
    .filter(item => item.id && item.symbol && item.price > 0 && item.qty > 0 && item.time > 0)
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  return { executions: items.length, items, trades: aggregateExecutionsIntoTrades(items) };
}

module.exports = { syncJournal };
