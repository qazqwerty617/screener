"use strict";

const DAY = 86400000;
const URL_BASE = "https://api.coinmarketcap.com/data-api/v3/token-unlock/listing";
const positive = n => (typeof n === "number" || typeof n === "string") && n !== "" && Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;

function normalizeCoinMarketCap(coins, now = Date.now()) {
  if (!Array.isArray(coins)) throw new Error("Invalid calendar rows");
  const rows = new Map();
  for (const coin of coins.slice(0, 5000)) {
    if (!coin || !Number.isSafeInteger(coin.cryptoId) || coin.cryptoId <= 0 ||
        typeof coin.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,120}$/.test(coin.slug)) continue;
    const at = positive(coin.nextUnlocked?.date), amount = positive(coin.nextUnlocked?.tokenAmount);
    if (!at || !amount || at < now - 90 * DAY || at > now + 365 * DAY) continue;
    const details = Array.isArray(coin.nextUnlockedDetail) ? coin.nextUnlockedDetail : [];
    const valid = details.length > 0 && details.length <= 500 && details.every(d => d && positive(d.tokenAmount));
    const sum = valid ? details.reduce((n, d) => n + Number(d.tokenAmount), 0) : 0;
    const groups = new Map();
    // The headline and allocations describe the same unlock: never add both.
    // If they disagree, retain the headline without claiming a known type.
    if (valid && Number.isFinite(sum) && Math.abs(sum - amount) <= Math.max(sum, amount) * 1e-6) {
      for (const detail of details) {
        const type = ["cliff", "linear", "tge", "inflationary", "deflationary", "non-linear"].includes(detail.vestingType) ? detail.vestingType : "unknown";
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push({ label: String(detail.allocationName || "Allocation").slice(0, 120), amount: Number(detail.tokenAmount) });
      }
    } else groups.set("unknown", []);
    for (const [unlockType, allocations] of groups) {
      const id = `cmc:${coin.cryptoId}:${at}:${unlockType}`;
      const value = allocations.length ? allocations.reduce((n, a) => n + a.amount, 0) : amount;
      const totalSupply = positive(coin.maxSupply) || positive(coin.totalSupply);
      const circulatingSupply = positive(coin.circulatingSupply);
      rows.set(id, { id, assetId: `cmc:${coin.cryptoId}`, symbol: typeof coin.symbol === "string" ? coin.symbol.slice(0, 30) : null,
        name: String(coin.name || coin.slug).slice(0, 120), at, amount: value, allocations, unlockType,
        provider: "CoinMarketCap", confidence: "aggregated", precision: "time", checkedAt: now,
        marketStatus: coin.isActive === 0 ? "inactive" : coin.isActive === 1 ? "active" : "unknown",
        allocationMismatch: valid && Math.abs(sum - amount) > Math.max(sum, amount) * 1e-6,
        totalSupply, circulatingSupply, percentSupply: totalSupply ? value / totalSupply * 100 : null,
        percentCirculating: circulatingSupply ? value / circulatingSupply * 100 : null,
        sources: [`https://coinmarketcap.com/currencies/${coin.slug}/#token_unlocks`] });
    }
  }
  return [...rows.values()];
}

async function loadCoinMarketCap(get, now = Date.now) {
  const coins = new Map(), deadline = now() + 45000;
  let total = null, pages = 0, sourceAsOf = null;
  // CMC's public table uses a 1-based page number, NOT a row offset.
  for (let page = 1; page <= Math.min(Math.ceil((total ?? 1) / 100), 50); page++) {
    if (now() >= deadline) throw new Error("Calendar deadline exceeded");
    const payload = JSON.parse(await get(`${URL_BASE}?start=${page}&limit=100&sort=next_unlocked_date&direction=desc&enableSmallUnlocks=true`));
    const data = payload.data;
    const count = typeof data?.totalCount === "string" && /^\d+$/.test(data.totalCount) ? Number(data.totalCount) : data?.totalCount;
    if (String(payload.status?.error_code) !== "0" || !Array.isArray(data?.tokenUnlockList) ||
        !Number.isSafeInteger(count) || count < 0 || data.tokenUnlockList.length > 100) throw new Error("Invalid calendar pagination");
    const timestamp = Date.parse(payload.status.timestamp);
    if (!Number.isFinite(timestamp) || now() - timestamp >= DAY || timestamp > now() + 5 * 60000) throw new Error("Stale source calendar");
    sourceAsOf = Math.min(sourceAsOf ?? timestamp, timestamp);
    if (total !== null && total !== count) throw new Error("Calendar changed during pagination");
    total = count;
    const before = coins.size;
    for (const coin of data.tokenUnlockList) if (Number.isSafeInteger(coin?.cryptoId) && coin.cryptoId > 0) coins.set(coin.cryptoId, coin);
    if (data.tokenUnlockList.length && before === coins.size) throw new Error("Calendar repeated a page");
    pages++;
  }
  const rows = normalizeCoinMarketCap([...coins.values()], now());
  return { rows, scannedTokens: coins.size, availableTokens: total, pages, partial: coins.size < total, sourceAsOf,
    inactiveTokens: new Set(rows.filter(row => row.marketStatus === "inactive").map(row => row.assetId)).size };
}

module.exports = { normalizeCoinMarketCap, loadCoinMarketCap };
