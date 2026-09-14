"use strict";

const crypto = require("crypto");
const {
  normalizeBinance,
  normalizeBybit,
  normalizeOkx,
  normalizeMexc,
} = require("./arbitrageTransferStatus");

function hmac(secret, value, encoding = "hex") {
  return crypto.createHmac("sha256", secret).update(value).digest(encoding);
}

async function fetchJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`wallet catalogue HTTP ${response.status}`);
  const payload = await response.json();
  const code = payload?.retCode ?? payload?.code;
  if (code != null && ![0, "0", "000000"].includes(code)) throw new Error(String(payload?.retMsg || payload?.msg || `wallet catalogue ${code}`));
  return payload;
}

async function fetchAuthenticatedCatalogue(exchange, credentials, fetchImpl = fetch, clock = Date.now) {
  const apiKey = String(credentials?.apiKey || "").trim();
  const apiSecret = String(credentials?.apiSecret || "").trim();
  const passphrase = String(credentials?.passphrase || "").trim();
  if (!apiKey || !apiSecret) throw new Error("missing read-only API credentials");
  const now = Number(clock());

  if (exchange === "BN") {
    const query = `timestamp=${now}&recvWindow=5000`;
    const signature = hmac(apiSecret, query);
    const payload = await fetchJson(fetchImpl, `https://api.binance.com/sapi/v1/capital/config/getall?${query}&signature=${signature}`, { "X-MBX-APIKEY": apiKey });
    return normalizeBinance(payload);
  }
  if (exchange === "BB") {
    const recvWindow = "5000";
    const signature = hmac(apiSecret, `${now}${apiKey}${recvWindow}`);
    const payload = await fetchJson(fetchImpl, "https://api.bybit.com/v5/asset/coin/query-info", {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": String(now),
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
    });
    return normalizeBybit(payload);
  }
  if (exchange === "OX") {
    if (!passphrase) throw new Error("OKX passphrase is required");
    const timestamp = new Date(now).toISOString();
    const requestPath = "/api/v5/asset/currencies";
    const signature = hmac(apiSecret, `${timestamp}GET${requestPath}`, "base64");
    const payload = await fetchJson(fetchImpl, `https://www.okx.com${requestPath}`, {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
    });
    return normalizeOkx(payload);
  }
  if (exchange === "MX") {
    const query = `timestamp=${now}&recvWindow=5000`;
    const signature = hmac(apiSecret, query);
    const payload = await fetchJson(fetchImpl, `https://api.mexc.com/api/v3/capital/config/getall?${query}&signature=${signature}`, { "X-MEXC-APIKEY": apiKey });
    return normalizeMexc(payload);
  }
  throw new Error(`unsupported authenticated catalogue: ${exchange}`);
}

module.exports = { fetchAuthenticatedCatalogue };
