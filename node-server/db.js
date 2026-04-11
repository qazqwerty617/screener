"use strict";
const Database = require("better-sqlite3");
const path = require("path");

// DB Initialization
const dbPath = path.join(__dirname, "klines.db");
const db = new Database(dbPath, { verbose: null });

// Create Tables & Indexes
db.exec(`
  CREATE TABLE IF NOT EXISTS klines (
    ex TEXT,
    sym TEXT,
    tf TEXT,
    t INTEGER,
    o REAL,
    h REAL,
    l REAL,
    c REAL,
    v REAL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_klines_main ON klines (ex, sym, tf, t);
  CREATE INDEX IF NOT EXISTS idx_klines_purge ON klines (tf, t);
`);

/**
 * Save candles to DB (Insert or Replace)
 */
function saveKlines(ex, sym, tf, candles) {
  if (!Array.isArray(candles) || candles.length === 0) return;
  
  const insert = db.prepare(`
    INSERT OR REPLACE INTO klines (ex, sym, tf, t, o, h, l, c, v)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((data) => {
    for (const k of data) {
      insert.run(ex, sym, tf, k.t, k.o, k.h, k.l, k.c, k.v);
    }
  });

  transaction(candles);
}

/**
 * Get cached candles from DB
 */
function getKlines(ex, sym, tf, limit = 1000) {
  const stmt = db.prepare(`
    SELECT t, o, h, l, c, v FROM klines
    WHERE ex = ? AND sym = ? AND tf = ?
    ORDER BY t DESC
    LIMIT ?
  `);
  
  const rows = stmt.all(ex, sym, tf, limit);
  // Return as objects or flat array depends on server.js needs
  return rows.reverse().map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
}

/**
 * Clean up old data to prevent DB bloat (Rolling Window)
 */
function pruneKlines() {
  const now = Date.now();
  
  const rules = [
    { tf: "1m",  ttl: 60 * 24 * 60 * 60 * 1000 },  // 60 days
    { tf: "5m",  ttl: 60 * 24 * 60 * 60 * 1000 },  // 60 days
    { tf: "15m", ttl: 180 * 24 * 60 * 60 * 1000 }, // 180 days (6 months)
    { tf: "1h",  ttl: 180 * 24 * 60 * 60 * 1000 }, // 180 days (6 months)
  ];

  for (const rule of rules) {
    const cutoff = now - rule.ttl;
    const stmt = db.prepare("DELETE FROM klines WHERE tf = ? AND t < ?");
    const info = stmt.run(rule.tf, cutoff);
    if (info.changes > 0) {
      console.log(`[DB PRUNE] Deleted ${info.changes} old records for TF: ${rule.tf}`);
    }
  }
}

module.exports = { saveKlines, getKlines, pruneKlines };
