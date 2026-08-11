"use strict";

const EXCHANGES = new Set(["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"]);
const TIMEFRAMES = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "3d", "1w"]);

function normalizeTimestamp(value) {
  let ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  if (ts > 1e17) ts /= 1e6; // nanoseconds
  else if (ts > 1e14) ts /= 1e3; // microseconds
  else if (ts < 1e11) ts *= 1000; // seconds
  return Math.floor(ts);
}

function normalizeCandle(raw) {
  if (!raw) return null;
  const t = normalizeTimestamp(raw.t);
  const o = Number(raw.o);
  const h = Number(raw.h);
  const l = Number(raw.l);
  const c = Number(raw.c);
  const v = Number(raw.v);
  if (!t || ![o, h, l, c].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  return {
    t,
    o,
    h: Math.max(h, o, l, c),
    l: Math.min(l, o, h, c),
    c,
    v: Number.isFinite(v) && v >= 0 ? v : 0,
  };
}

function validSubscription(ex, sym, tf) {
  return EXCHANGES.has(String(ex || ""))
    && TIMEFRAMES.has(String(tf || ""))
    && /^[A-Z0-9:_-]{1,80}$/i.test(String(sym || ""));
}

function mergeMarketTick(previous, event) {
  const t = normalizeTimestamp(event?.t);
  const p = Number(event?.p);
  if (!t || !Number.isFinite(p) || p <= 0) return previous || null;
  const current = previous || {
    firstTime: t,
    eventTime: t,
    first: p,
    last: p,
    high: p,
    low: p,
    trades: 0,
    volume: 0,
  };
  if (t < current.firstTime) {
    current.firstTime = t;
    current.first = p;
  }
  current.eventTime = Math.max(current.eventTime, t);
  current.high = Math.max(current.high, p);
  current.low = Math.min(current.low, p);
  current.trades += Math.max(1, Number(event.trades) || 1);
  current.volume += Math.max(0, Number(event.volume) || 0);
  if (t >= current.eventTime || !current.last) current.last = p;
  return current;
}

module.exports = {
  EXCHANGES,
  TIMEFRAMES,
  normalizeTimestamp,
  normalizeCandle,
  validSubscription,
  mergeMarketTick,
};
