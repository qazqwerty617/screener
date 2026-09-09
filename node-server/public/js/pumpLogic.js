"use strict";

(function exposePumpLogic(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PumpLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPumpLogic() {
  const EXCHANGE_CODES = Object.freeze(["BN", "BB", "OX", "BG", "GT", "MX", "HL", "AD", "BX", "KC", "HT"]);
  const EXCHANGE_ALIASES = Object.freeze({
    BN: "BN", BINANCE: "BN",
    BB: "BB", BYBIT: "BB",
    OX: "OX", OKX: "OX",
    BG: "BG", BITGET: "BG",
    GT: "GT", GATE: "GT", GATEIO: "GT",
    MX: "MX", MEXC: "MX",
    HL: "HL", HYPERLIQUID: "HL",
    AD: "AD", ASTER: "AD", ASTERDEX: "AD",
    BX: "BX", BINGX: "BX",
    KC: "KC", KUCOIN: "KC",
    HT: "HT", HTX: "HT", HUOBI: "HT"
  });

  function canonicalExchange(value) {
    const raw = String(value || "").trim().toUpperCase();
    if (raw === "ALL" || raw === "ВСЕ") return "all";
    return EXCHANGE_ALIASES[raw.replace(/[^A-Z0-9]/g, "")] || "";
  }

  function normalizeExchanges(values) {
    if (!Array.isArray(values)) return [];
    const normalized = [];
    const seen = new Set();
    for (const value of values) {
      const code = canonicalExchange(value);
      if (code === "all") return ["all"];
      if (code && !seen.has(code)) {
        seen.add(code);
        normalized.push(code);
      }
    }
    return normalized;
  }

  function isExchangeAllowed(exchange, selected) {
    const code = canonicalExchange(exchange);
    if (!code || code === "all") return false;
    const allowed = normalizeExchanges(selected);
    return allowed.includes("all") || allowed.includes(code);
  }

  function toggleExchangeSelection(current, clicked) {
    const selected = normalizeExchanges(current);
    const code = canonicalExchange(clicked);
    if (!code) return selected;
    if (code === "all") return selected.includes("all") ? [] : ["all"];

    // "All" is a mode, not eleven independently selected buttons. Starting
    // from that mode and clicking Binance must mean "Binance only".
    if (selected.includes("all")) return [code];

    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    return EXCHANGE_CODES.filter(exchange => next.has(exchange));
  }

  function finitePositive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function adaptiveThreshold(minPct, volume) {
    const requested = Math.max(0.1, finitePositive(minPct) || 1);
    const quoteVolume = finitePositive(volume);
    if (quoteVolume < 100_000) return Math.max(requested, 4);
    if (quoteVolume < 500_000) return Math.max(requested, 2.5);
    if (quoteVolume < 2_000_000) return Math.max(requested, 1.5);
    return requested;
  }

  function analyzeMove(samples, options = {}) {
    const now = Number(options.now) || Date.now();
    const periodMs = Math.max(30_000, Number(options.periodMs) || 5 * 60_000);
    const volume = finitePositive(options.volume);
    const threshold = adaptiveThreshold(options.minPct, volume);
    const directionFilter = String(options.direction || "both").toLowerCase();

    const clean = (Array.isArray(samples) ? samples : [])
      .map(sample => ({ t: Number(sample?.t), p: finitePositive(sample?.p) }))
      .filter(sample => Number.isFinite(sample.t) && sample.p > 0 && sample.t <= now + 2_000)
      .sort((a, b) => a.t - b.t);
    if (clean.length < 2) return { accepted: false, reason: "insufficient_history", threshold };

    const target = now - periodMs;
    let referenceIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < clean.length; i++) {
      const distance = Math.abs(clean[i].t - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        referenceIndex = i;
      }
    }

    const reference = clean[referenceIndex];
    const latest = clean[clean.length - 1];
    const coverage = (latest.t - reference.t) / periodMs;
    if (coverage < 0.65 || bestDistance > Math.max(45_000, periodMs * 0.35)) {
      return { accepted: false, reason: "insufficient_coverage", threshold, coverage };
    }

    const pct = ((latest.p - reference.p) / reference.p) * 100;
    const absPct = Math.abs(pct);
    const maxDrop = periodMs <= 60_000 ? 35 : periodMs <= 5 * 60_000 ? 50 : 75;
    if (!Number.isFinite(pct) || pct <= -maxDrop || pct >= 250) {
      return { accepted: false, reason: "impossible_move", threshold, pct };
    }
    if (absPct < threshold) return { accepted: false, reason: "below_threshold", threshold, pct };

    const direction = pct > 0 ? "pump" : "dump";
    if ((directionFilter === "pump" && direction !== "pump") || (directionFilter === "dump" && direction !== "dump")) {
      return { accepted: false, reason: "direction", threshold, pct, direction };
    }

    const path = clean.slice(referenceIndex);
    let travelledPct = 0;
    let largestCounterPct = 0;
    for (let i = 1; i < path.length; i++) {
      const stepPct = ((path[i].p - path[i - 1].p) / path[i - 1].p) * 100;
      travelledPct += Math.abs(stepPct);
      const isCounter = direction === "pump" ? stepPct < 0 : stepPct > 0;
      if (isCounter) largestCounterPct = Math.max(largestCounterPct, Math.abs(stepPct));
    }
    const efficiency = travelledPct > 0 ? Math.min(1, absPct / travelledPct) : 0;
    if (path.length >= 4 && (efficiency < 0.28 || (largestCounterPct > absPct * 0.8 && efficiency < 0.55))) {
      return { accepted: false, reason: "noisy_path", threshold, pct, direction, efficiency };
    }

    const strength = Math.min(1, absPct / Math.max(threshold * 1.5, 0.1));
    const liquidity = volume >= 10_000_000 ? 1 : volume >= 2_000_000 ? 0.9 : volume >= 500_000 ? 0.7 : volume >= 100_000 ? 0.45 : 0.2;
    const quality = Math.max(0, Math.min(1, strength * 0.45 + efficiency * 0.35 + liquidity * 0.20));

    return {
      accepted: true,
      direction,
      pct,
      absPct,
      threshold,
      quality,
      efficiency,
      coverage,
      referencePrice: reference.p,
      referenceTime: reference.t,
      latestPrice: latest.p,
      latestTime: latest.t,
      points: path.length
    };
  }

  class SignalConfirmationGate {
    constructor(options = {}) {
      this.minConfirmations = Math.max(1, Number(options.minConfirmations) || 2);
      this.minSpacingMs = Math.max(0, Number(options.minSpacingMs) || 250);
      this.ttlMs = Math.max(this.minSpacingMs, Number(options.ttlMs) || 10_000);
      this.maxEntries = Math.max(100, Number(options.maxEntries) || 20_000);
      this.entries = new Map();
    }

    observe(key, direction, now = Date.now(), pct = 0) {
      const id = `${key}:${direction}`;
      const opposite = `${key}:${direction === "pump" ? "dump" : "pump"}`;
      this.entries.delete(opposite);
      let entry = this.entries.get(id);
      if (!entry || now - entry.lastAt > this.ttlMs) {
        entry = { count: 1, firstAt: now, lastAt: now, pct };
        this.entries.set(id, entry);
        this.prune(now);
        return this.minConfirmations <= 1;
      }
      if (now - entry.lastAt < this.minSpacingMs) return false;
      entry.count++;
      entry.lastAt = now;
      entry.pct = pct;
      return entry.count >= this.minConfirmations;
    }

    clear(key) {
      if (!key) return this.entries.clear();
      this.entries.delete(`${key}:pump`);
      this.entries.delete(`${key}:dump`);
    }

    prune(now = Date.now()) {
      if (this.entries.size < this.maxEntries) return;
      for (const [key, entry] of this.entries) {
        if (now - entry.lastAt > this.ttlMs) this.entries.delete(key);
      }
      if (this.entries.size <= this.maxEntries) return;
      const excess = this.entries.size - this.maxEntries;
      let removed = 0;
      for (const key of this.entries.keys()) {
        this.entries.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  return {
    EXCHANGE_CODES,
    canonicalExchange,
    normalizeExchanges,
    isExchangeAllowed,
    toggleExchangeSelection,
    adaptiveThreshold,
    analyzeMove,
    SignalConfirmationGate
  };
});
