"use strict";

const { primaryUnlocks, SCHEDULES, REVIEWED_AT } = require("./unlockSchedules");
const { createPublicUnlocks } = require("./publicUnlocks");
const DAY = 86400000;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch (_) { return null; }
}

function normalizeEmissions(payload, now = Date.now()) {
  if (!Array.isArray(payload)) throw new Error("Invalid emissions response");
  const rows = new Map();
  for (const token of payload.slice(0, 3000)) {
    const identity = String(token.gecko_id || token.token || "").replace(/^coingecko:/, "");
    if (!identity) continue;
    const known = SCHEDULES.find(item => item.geckoId === identity);
    const sources = [...new Set((Array.isArray(token.sources) ? token.sources : []).map(safeUrl).filter(Boolean))].slice(0, 8);
    const events = Array.isArray(token.unlockEvents) && token.unlockEvents.length ? token.unlockEvents : token.events;
    for (const event of (Array.isArray(events) ? events : []).slice(0, 3000)) {
      // A linear emission is a rate, never a lump-sum cliff. Only sum explicit cliffs.
      let amount = null, allocations = [];
      if (Array.isArray(event.cliffAllocations)) {
        allocations = event.cliffAllocations.filter(a => positive(a.amount)).map(a => ({ label: String(a.recipient || a.category || "Cliff").slice(0, 100), amount: Number(a.amount) }));
        amount = allocations.reduce((sum, a) => sum + a.amount, 0);
      } else if (event.unlockType === "cliff" && Array.isArray(event.noOfTokens)) {
        amount = event.noOfTokens.reduce((sum, n) => sum + (positive(n) || 0), 0);
        allocations = [{ label: String(event.category || "Cliff").slice(0, 100), amount }];
      }
      const rawTime = Number(event.timestamp);
      const at = rawTime < 1e11 ? rawTime * 1000 : rawTime;
      if (!positive(amount) || !Number.isFinite(at) || at < now - 90 * DAY || at > now + 365 * DAY) continue;
      const id = `llama:${identity}:${at}`;
      const previous = rows.get(id);
      if (previous) { previous.amount += amount; previous.allocations.push(...allocations); continue; }
      rows.set(id, { id, symbol: known?.symbol || null, name: String(token.name || identity).slice(0, 100),
        geckoId: identity, at, amount, allocations, totalSupply: positive(token.maxSupply),
        circulatingSupply: positive(token.circSupply), sources, provider: "DefiLlama", confidence: "aggregated",
        precision: "time", checkedAt: now });
    }
  }
  return [...rows.values()].map(row => ({ ...row,
    percentSupply: row.totalSupply ? row.amount / row.totalSupply * 100 : null,
    percentCirculating: row.circulatingSupply ? row.amount / row.circulatingSupply * 100 : null }));
}

function createUnlockService({ apiKey = process.env.DEFILLAMA_API_KEY || "", request = fetch, now = Date.now, publicSources = true } = {}) {
  const publicCalendar = publicSources ? createPublicUnlocks({ request, now }) : null;
  let rows = [], updatedAt = null, checkedAt = null, retryAt = 0, pending = null;
  let status = apiKey ? "pending" : "not_configured";
  async function refreshPaid() {
    if (!apiKey || now() < retryAt) return;
    if (pending) return pending;
    pending = (async () => {
      checkedAt = now();
      try {
        const response = await request(`https://pro-api.llama.fi/${encodeURIComponent(apiKey)}/api/emissions`,
          { signal: AbortSignal.timeout(12000), redirect: "error" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // The paid API credential is in the URL; never persist/log a raw error.
        if (Number(response.headers?.get("content-length")) > 20000000) throw new Error("Too large");
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 20000000) throw new Error("Too large");
          chunks.push(chunk);
        }
        rows = normalizeEmissions(JSON.parse(Buffer.concat(chunks).toString("utf8")), now());
        updatedAt = now(); status = "ok"; retryAt = now() + 30 * 60000;
      } catch (_) { status = "error"; retryAt = now() + 5 * 60000; }
    })().finally(() => { pending = null; });
    return pending;
  }
  function snapshot() {
    const primary = primaryUnlocks(now());
    // Keep primary schedules when an aggregator fails. Both provenances are
    // retained separately; a disagreement must not silently become a new fact.
    const freshRows = updatedAt && now() - updatedAt < DAY ? rows : [];
    const free = publicCalendar?.snapshot() || { rows: [], sources: {} };
    return { rows: [...primary.map(row => ({ ...row, unlockType: "scheduled" })), ...free.rows, ...freshRows.map(row => ({ ...row, unlockType: "cliff" }))].sort((a, b) => a.at - b.at), updatedAt,
      sources: { primary: { status: "reviewed_schedule", reviewedAt: REVIEWED_AT, tokens: SCHEDULES.length },
        ...free.sources,
        defillama: { status, checkedAt, updatedAt, stale: !!updatedAt && now() - updatedAt >= 3600000 } },
      coverage: free.rows.length ? "public_calendars" : apiKey ? "primary_and_aggregator" : "primary_only" };
  }
  return { refresh: () => Promise.allSettled([refreshPaid(), publicCalendar?.refresh()]), snapshot };
}
module.exports = { createUnlockService, normalizeEmissions };
