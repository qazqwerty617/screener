"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// priceHistoryStore.js — Compact shared price history for pump/dump detection.
//
// Replaces two independent Map<string, Array<{t,p}>> ring buffers (one in
// alertEngine, one in server.js). At the live ticker count (~8.5k keys) the
// object-per-sample layout cost ~78 bytes per sample, so a few hundred samples
// per key ran into hundreds of megabytes each — against a 1024 MB heap and an
// orchestrator that recycles the process above ~950 MB. Those recycles wiped
// every in-memory alert cooldown, which is what made alerts fire in bursts and
// then go quiet.
//
// Here each key holds two parallel typed arrays (12 bytes per sample) in a ring
// buffer, sampled at a fixed resolution. 480 samples at 30s covers 4 hours for
// ~5 KB per key.
// ═══════════════════════════════════════════════════════════════════════════════

// One sample per 30s is enough for every lookback the UI offers (min 1 minute);
// detection always compares against live ticker price, not a stored sample.
const RESOLUTION_MS = 30000;
const CAPACITY = 480;                  // 480 * 30s = 4 hours
const SPAN_MS = RESOLUTION_MS * CAPACITY;

class PriceHistoryStore {
  constructor(capacity = CAPACITY, resolutionMs = RESOLUTION_MS) {
    this.capacity = capacity;
    this.resolutionMs = resolutionMs;
    this.map = new Map(); // key -> { sec: Uint32Array, px: Float64Array, head, len, lastMs }
  }

  _entry(key) {
    let e = this.map.get(key);
    if (!e) {
      e = {
        sec: new Uint32Array(this.capacity),
        px: new Float64Array(this.capacity),
        head: 0, // index of the next write slot
        len: 0,
        lastMs: 0
      };
      this.map.set(key, e);
    }
    return e;
  }

  /**
   * Record a price. Silently ignored if the previous sample for this key is
   * newer than the sampling resolution, or if the move looks like a corrupt
   * 4x single-tick spike.
   * @returns {boolean} true when a sample was stored
   */
  push(key, timestampMs, price) {
    if (!key || !(price > 0) || !Number.isFinite(price)) return false;
    const e = this._entry(key);

    if (e.len > 0) {
      if (timestampMs - e.lastMs < this.resolutionMs) return false;
      const prev = e.px[(e.head - 1 + this.capacity) % this.capacity];
      if (prev > 0 && (price / prev > 4 || prev / price > 4)) return false;
    }

    e.sec[e.head] = Math.floor(timestampMs / 1000);
    e.px[e.head] = price;
    e.head = (e.head + 1) % this.capacity;
    if (e.len < this.capacity) e.len++;
    e.lastMs = timestampMs;
    return true;
  }

  /** Index in storage order: 0 = oldest retained sample. */
  _slot(e, i) {
    return (e.head - e.len + i + this.capacity * 2) % this.capacity;
  }

  sampleCount(key) {
    const e = this.map.get(key);
    return e ? e.len : 0;
  }

  /** Timestamp (ms) of the oldest retained sample, or 0. */
  oldestTime(key) {
    const e = this.map.get(key);
    if (!e || e.len === 0) return 0;
    return e.sec[this._slot(e, 0)] * 1000;
  }

  newestTime(key) {
    const e = this.map.get(key);
    return e ? e.lastMs : 0;
  }

  /**
   * Newest sample at or before `targetMs`. Falls back to the oldest retained
   * sample when the target predates the whole window, mirroring the previous
   * behaviour so young histories still produce alerts.
   * @returns {{t:number,p:number}|null}
   */
  findAtOrBefore(key, targetMs) {
    const e = this.map.get(key);
    if (!e || e.len === 0) return null;
    const targetSec = Math.floor(targetMs / 1000);

    // Samples are in ascending time order; walk back from the newest.
    for (let i = e.len - 1; i >= 0; i--) {
      const slot = this._slot(e, i);
      if (e.sec[slot] <= targetSec) {
        return { t: e.sec[slot] * 1000, p: e.px[slot] };
      }
    }
    const first = this._slot(e, 0);
    return { t: e.sec[first] * 1000, p: e.px[first] };
  }

  /** Sample nearest to `targetMs` in either direction, with its time delta. */
  findNearest(key, targetMs) {
    const e = this.map.get(key);
    if (!e || e.len === 0) return null;
    const targetSec = Math.floor(targetMs / 1000);
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < e.len; i++) {
      const slot = this._slot(e, i);
      const diff = Math.abs(e.sec[slot] - targetSec);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = slot;
      }
    }
    if (best < 0) return null;
    return { t: e.sec[best] * 1000, p: e.px[best], diffMs: bestDiff * 1000 };
  }

  /**
   * Materialize the series as plain objects. Only for the handful of keys that
   * need it at a time (chart fallback), never for the whole map.
   * @returns {Array<{t:number,p:number}>}
   */
  toSeries(key) {
    const e = this.map.get(key);
    if (!e || e.len === 0) return [];
    const out = new Array(e.len);
    for (let i = 0; i < e.len; i++) {
      const slot = this._slot(e, i);
      out[i] = { t: e.sec[slot] * 1000, p: e.px[slot] };
    }
    return out;
  }

  /** Replace a key's contents. Used by tests and history back-fill. */
  setSeries(key, samples) {
    this.map.delete(key);
    if (!Array.isArray(samples) || samples.length === 0) return;
    const e = this._entry(key);
    const start = Math.max(0, samples.length - this.capacity);
    for (let i = start; i < samples.length; i++) {
      const s = samples[i];
      if (!s || !(s.p > 0)) continue;
      e.sec[e.head] = Math.floor(s.t / 1000);
      e.px[e.head] = s.p;
      e.head = (e.head + 1) % this.capacity;
      if (e.len < this.capacity) e.len++;
      e.lastMs = s.t;
    }
  }

  delete(key) {
    return this.map.delete(key);
  }

  /** Drop keys that stopped ticking (delistings, renamed pairs). */
  pruneStale(now, ttlMs) {
    let removed = 0;
    for (const [key, e] of this.map) {
      if (now - e.lastMs > ttlMs) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size() {
    return this.map.size;
  }

  keys() {
    return this.map.keys();
  }

  /** Approximate retained bytes, for diagnostics. */
  stats() {
    const bytesPerKey = this.capacity * 12;
    return {
      keys: this.map.size,
      capacity: this.capacity,
      resolutionMs: this.resolutionMs,
      spanMs: this.resolutionMs * this.capacity,
      approxBytes: this.map.size * bytesPerKey
    };
  }
}

module.exports = {
  PriceHistoryStore,
  RESOLUTION_MS,
  CAPACITY,
  SPAN_MS,
  // Process-wide instance shared by alertEngine and the HTTP pump/dump endpoint.
  sharedStore: new PriceHistoryStore()
};
