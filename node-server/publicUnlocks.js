"use strict";

const DAY = 86400000;
const DROPS_URL = "https://dropstab.com/_gateway/api/portfolio/api/markets";
const TOKENOMIST_URL = "https://tokenomist.ai/";
const positive = n => (typeof n === "number" || typeof n === "string") && n !== "" && Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
const label = n => String(n || "").slice(0, 120);
const slug = n => typeof n === "string" && /^[a-z0-9][a-z0-9-]{0,120}$/i.test(n) ? n : null;
const symbol = n => typeof n === "string" && /^[a-z0-9][a-z0-9._-]{0,24}$/i.test(n) ? n.toUpperCase() : null;

function normalizeDrops(coins, now = Date.now()) {
  if (!Array.isArray(coins)) throw new Error("Invalid DropsTab coins");
  const events = new Map(), seen = new Set();
  for (const coin of coins.slice(0, 3000)) {
    if (!coin || !slug(coin.slug) || !positive(coin.currencyId)) continue;
    const sales = coin.fundraisingBaseData?.nextUnlocksBySales;
    for (const sale of (Array.isArray(sales) ? sales : []).slice(0, 500)) {
      if (!sale || typeof sale !== "object") continue;
      const at = Number(sale.date), amount = positive(sale.tokens);
      if (!amount || !Number.isFinite(at) || at < now - 90 * DAY || at > now + 365 * DAY) continue;
      const type = sale.unlockType === "CLIFF" ? "cliff" : sale.unlockType === "LINEAR" ? "linear" : "unknown";
      const id = `dropstab:${coin.currencyId}:${at}:${type}`;
      // Repeated pages or duplicate allocations must not increase the amount.
      const allocationId = `${id}:${sale.saleId ?? label(sale.sale)}`;
      if (seen.has(allocationId)) continue;
      seen.add(allocationId);
      if (!events.has(id)) events.set(id, {
        id, assetId: `dropstab:${coin.currencyId}`, symbol: symbol(coin.symbol), name: label(coin.name || coin.slug),
        at, amount: 0, allocations: [], totalSupply: positive(coin.maxSupply) || positive(coin.totalSupply),
        circulatingSupply: positive(coin.circulatingSupply), provider: "DropsTab", confidence: "aggregated",
        unlockType: type, precision: "day", checkedAt: now,
        sources: [`https://dropstab.com/coins/${coin.slug}/vesting`],
      });
      const row = events.get(id);
      row.amount += amount;
      row.allocations.push({ label: label(sale.sale || "Allocation"), amount });
    }
  }
  return [...events.values()].filter(row => Number.isFinite(row.amount)).map(row => ({ ...row,
    percentSupply: row.totalSupply ? row.amount / row.totalSupply * 100 : null,
    percentCirculating: row.circulatingSupply ? row.amount / row.circulatingSupply * 100 : null }));
}

// Read only JSON records from the public server-rendered page. Never evaluate
// scripts and never follow auth redirects or gated pagination.
function publicVestingList(html) {
  if (typeof html !== "string" || html.length > 6000000) throw new Error("Invalid calendar page");
  let rsc = "";
  for (const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)\s*;?\s*<\/script>/g)) {
    try { const chunk = JSON.parse(match[1]); if (chunk[0] === 1 && typeof chunk[1] === "string") rsc += chunk[1]; } catch (_) {}
  }
  let visited = 0;
  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 25 || ++visited > 50000) return null;
    if (value.initialVestingList?.rows) return value.initialVestingList;
    for (const [key, item] of Object.entries(value)) {
      if (key === "messages" || key === "translations") continue;
      const found = walk(item, depth + 1); if (found) return found;
    }
    return null;
  }
  for (const line of rsc.split("\n")) {
    try { const found = walk(JSON.parse(line.slice(line.indexOf(":") + 1))); if (found) return found; } catch (_) {}
  }
  throw new Error("Public calendar format changed");
}

function normalizeTokenomist(list, now = Date.now()) {
  if (!Array.isArray(list?.rows)) throw new Error("Invalid Tokenomist calendar");
  const rows = new Map();
  for (const table of list.rows) {
    if (!table || !Array.isArray(table.k) || !Array.isArray(table.r) || table.k.length > 100) continue;
    for (const values of table.r.slice(0, 500)) {
      if (!Array.isArray(values)) continue;
      const token = Object.fromEntries(table.k.map((key, i) => [key, values[i]]));
      const event = token.upcomingEvent;
      if (!slug(token.tokenSlug) || !event || token.skipUpcomingUnlockEvent === true) continue;
      const at = Number(event.dateUnix) * 1000, amount = positive(event.amount);
      if (!amount || !Number.isFinite(at) || at < now - 90 * DAY || at > now + 365 * DAY) continue;
      const precision = String(event.precision || "").toLowerCase();
      if (!["second", "block", "hour", "day", "week", "month"].includes(precision)) continue;
      const date = new Date(at), day = Math.floor(at / DAY) * DAY;
      // Provider methodology: Month = any day of that month, Week = ±3 days.
      const windowStart = precision === "month" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
        : precision === "week" ? day - 3 * DAY : precision === "day" ? day : precision === "hour" ? Math.floor(at / 3600000) * 3600000 : at;
      const windowEnd = precision === "month" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1
        : precision === "week" ? day + 4 * DAY - 1 : precision === "day" ? day + DAY - 1 : precision === "hour" ? windowStart + 3599999 : at;
      const id = `tokenomist:${token.tokenSlug}:${at}`;
      rows.set(id, { id, assetId: `tokenomist:${token.tokenSlug}`, symbol: symbol(token.tokenSymbol), name: label(token.tokenName),
        at, windowStart, windowEnd, amount, allocations: [], provider: "Tokenomist", confidence: "aggregated",
        unlockType: "unknown", precision, checkedAt: now,
        totalSupply: positive(token.tokenReferenceMaxSupply), circulatingSupply: positive(token.tokenCirculatingSupply),
        sources: [`https://tokenomist.ai/${token.tokenSlug}`] });
    }
  }
  return [...rows.values()].map(row => ({ ...row, percentSupply: row.totalSupply ? row.amount / row.totalSupply * 100 : null }));
}

async function readResponse(response, maxBytes = 6000000) {
  if (!response.ok || Number(response.headers?.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(!response.ok ? `HTTP ${response.status}` : "Response too large");
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Response too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function createPublicUnlocks({ request = fetch, now = Date.now } = {}) {
  const states = Object.fromEntries(["dropstab", "tokenomist"].map(key => [key, {
    status: "pending", rows: [], checkedAt: null, updatedAt: null, retryAt: 0, pending: null,
    tokens: 0, scannedTokens: 0, availableTokens: null, pages: 0, partial: true,
  }]));
  async function get(url, options = {}) {
    return readResponse(await request(url, { ...options, signal: AbortSignal.timeout(15000), redirect: "error" }));
  }
  async function drops() {
    const deadline = now() + 45000;
    const coins = new Map(); let pages = 1, availableTokens = 0, fetched = 0;
    for (let page = 0; page < Math.min(pages, 40); page++) {
      if (now() >= deadline) throw new Error("Calendar deadline exceeded");
      const body = { fields: ["currencyId", "name", "symbol", "slug", "circulatingSupply", "maxSupply", "totalSupply", "fundraisingBaseData"],
        filters: { vestingPeriod: true }, sort: "next_unlock_date", order: "ASC", sortRange: "FULL", page, size: 50 };
      const payload = JSON.parse(await get(DROPS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const market = payload.markets;
      if (!Array.isArray(market?.content) || !Number.isInteger(market.totalPages) || market.totalPages < 0 || market.number !== page) throw new Error("Invalid calendar pagination");
      pages = market.totalPages; availableTokens = market.totalElements;
      let added = 0;
      for (const coin of market.content) {
        if (coin?.currencyId && !coins.has(coin.currencyId)) { coins.set(coin.currencyId, coin); added++; }
      }
      fetched++;
      if (page > 0 && market.content.length && !added) throw new Error("Calendar repeated a page");
    }
    return { rows: normalizeDrops([...coins.values()], now()), scannedTokens: coins.size,
      availableTokens, pages: fetched, partial: fetched < pages || coins.size < availableTokens };
  }
  async function tokenomist() {
    const list = publicVestingList(await get(TOKENOMIST_URL));
    const sourceAsOf = Date.parse(list.metadata?.queryDate);
    if (Number.isFinite(sourceAsOf) && (now() - sourceAsOf > DAY || sourceAsOf > now() + 5 * 60000)) throw new Error("Stale source calendar");
    return { rows: normalizeTokenomist(list, now()), sourceAsOf: Number.isFinite(sourceAsOf) ? sourceAsOf : null, scannedTokens: list.rows.reduce((n, t) => n + (t?.r?.length || 0), 0),
      availableTokens: positive(list.metadata?.total), pages: 1, partial: true };
  }
  function refreshOne(key, loader) {
    const state = states[key];
    if (state.pending) return state.pending;
    if (now() < state.retryAt) return Promise.resolve();
    state.checkedAt = now();
    state.pending = (async () => {
      try {
        const result = await loader();
        Object.assign(state, result, { tokens: new Set(result.rows.map(r => r.assetId)).size, status: result.rows.length ? "ok" : "empty", error: null, updatedAt: now(), retryAt: now() + 30 * 60000 });
      } catch (error) {
        state.status = "error"; state.retryAt = now() + 5 * 60000;
        state.error = /^(HTTP \d{3}|Response too large|Invalid calendar pagination|Calendar repeated a page|No usable unlock data|Public calendar format changed)$/.test(error.message) ? error.message : "Source unavailable";
      }
    })().finally(() => { state.pending = null; });
    return state.pending;
  }
  function snapshot() {
    const rows = [], sources = {};
    for (const [key, state] of Object.entries(states)) {
      const fresh = state.updatedAt !== null && now() - state.updatedAt < DAY;
      const stale = state.updatedAt !== null && now() - state.updatedAt >= 3600000;
      if (fresh) rows.push(...state.rows.map(row => ({ ...row, stale })));
      const { rows: _rows, pending: _pending, retryAt: _retry, ...health } = state;
      sources[key] = { ...health, stale, expired: state.updatedAt !== null && !fresh, tokens: fresh ? state.tokens : 0 };
    }
    return { rows, sources };
  }
  return { refresh: () => Promise.allSettled([refreshOne("dropstab", drops), refreshOne("tokenomist", tokenomist)]), snapshot };
}

module.exports = { createPublicUnlocks, normalizeDrops, normalizeTokenomist, publicVestingList, readResponse };
