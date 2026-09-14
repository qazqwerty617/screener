"use strict";

const crypto = require("crypto");

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeExecution(execution) {
  const side = String(execution.side || "").toUpperCase();
  const positionSide = String(execution.positionSide || "BOTH").toUpperCase();
  return {
    id: String(execution.id || execution.execId || execution.tradeId || ""),
    orderId: String(execution.orderId || ""),
    symbol: String(execution.symbol || "").toUpperCase(),
    exchange: String(execution.exchange || ""),
    side: side === "SELL" ? "SELL" : "BUY",
    positionSide: positionSide === "LONG" || positionSide === "SHORT" ? positionSide : "BOTH",
    price: Math.max(0, number(execution.price)),
    qty: Math.max(0, number(execution.qty)),
    realizedPnl: number(execution.realizedPnl),
    fee: Math.abs(number(execution.fee)),
    time: Math.max(0, Math.trunc(number(execution.time))),
  };
}

function stableTradeId(exchange, symbol, executions) {
  const seed = `${exchange}|${symbol}|${executions.map(item => item.id || `${item.time}:${item.side}:${item.qty}`).join("|")}`;
  return `sync_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 20)}`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}

function aggregateExecutionsIntoTrades(rawExecutions, options = {}) {
  const source = Array.isArray(rawExecutions) ? rawExecutions : [];
  const deduped = new Map();
  for (const raw of source) {
    const exec = normalizeExecution(raw || {});
    if (!exec.symbol || !exec.exchange || !exec.price || !exec.qty || !exec.time) continue;
    const key = exec.id || `${exec.exchange}|${exec.symbol}|${exec.time}|${exec.side}|${exec.price}|${exec.qty}|${exec.realizedPnl}`;
    if (!deduped.has(key)) deduped.set(key, exec);
  }

  const groups = new Map();
  for (const exec of deduped.values()) {
    const key = `${exec.exchange}|${exec.symbol}|${exec.positionSide}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(exec);
  }

  const trades = [];
  const epsilon = 1e-10;

  for (const executions of groups.values()) {
    executions.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    let positionQty = 0;
    let direction = null;
    let tradeExecutions = [];
    let entryNotional = 0;
    let entryQty = 0;
    let exitNotional = 0;
    let exitQty = 0;
    let realizedPnl = 0;
    let fees = 0;
    let startedAt = 0;

    const flush = (endedAt, incomplete = false) => {
      if (!tradeExecutions.length || !entryQty || !exitQty) {
        if (!incomplete) {
          tradeExecutions = [];
          entryNotional = entryQty = exitNotional = exitQty = realizedPnl = fees = 0;
          startedAt = 0;
        }
        return;
      }
      const exchange = tradeExecutions[0].exchange;
      const symbol = tradeExecutions[0].symbol;
      const entry = entryNotional / entryQty;
      const exit = exitNotional / exitQty;
      const pnl = realizedPnl - fees;
      const basis = Math.max(entryNotional, entry * exitQty, epsilon);
      const normalizedExecutions = tradeExecutions.map(item => ({
        id: item.id,
        orderId: item.orderId,
        side: item.side,
        positionSide: item.positionSide,
        price: item.price,
        size: item.qty,
        qty: item.qty,
        date: formatDate(item.time),
        time: item.time,
        pnl: item.realizedPnl - item.fee,
        realizedPnl: item.realizedPnl,
        fee: item.fee,
      }));
      trades.push({
        id: stableTradeId(exchange, symbol, tradeExecutions),
        source: "api",
        schemaVersion: 4,
        date: formatDate(startedAt || tradeExecutions[0].time),
        entryTime: startedAt || tradeExecutions[0].time,
        exitTime: endedAt || tradeExecutions[tradeExecutions.length - 1].time,
        durationMs: Math.max(0, (endedAt || 0) - (startedAt || 0)),
        symbol,
        exchange,
        side: direction || "LONG",
        entry: +entry.toPrecision(12),
        exit: +exit.toPrecision(12),
        size: +Math.min(entryQty, exitQty).toPrecision(12),
        pnl: +pnl.toFixed(8),
        realizedPnl: +realizedPnl.toFixed(8),
        pnlPercent: +(pnl / basis * 100).toFixed(4),
        fee: +fees.toFixed(8),
        executions: normalizedExecutions,
        incomplete: Boolean(incomplete),
        tags: ["Синхронизировано по API"],
        note: `${tradeExecutions.length} исполнений, объединённых в одну сделку`,
      });
      tradeExecutions = [];
      entryNotional = entryQty = exitNotional = exitQty = realizedPnl = fees = 0;
      startedAt = 0;
      direction = null;
    };

    for (const exec of executions) {
      let signedQty;
      if (exec.positionSide === "LONG") signedQty = exec.side === "BUY" ? exec.qty : -exec.qty;
      else if (exec.positionSide === "SHORT") signedQty = exec.side === "SELL" ? -exec.qty : exec.qty;
      else signedQty = exec.side === "BUY" ? exec.qty : -exec.qty;

      if (Math.abs(positionQty) <= epsilon) {
        direction = signedQty > 0 ? "LONG" : "SHORT";
        startedAt = exec.time;
      }

      const sameDirection = Math.abs(positionQty) <= epsilon || Math.sign(positionQty) === Math.sign(signedQty);
      tradeExecutions.push(exec);
      fees += exec.fee;
      realizedPnl += exec.realizedPnl;

      if (sameDirection) {
        entryQty += exec.qty;
        entryNotional += exec.price * exec.qty;
        positionQty += signedQty;
        continue;
      }

      const closingQty = Math.min(Math.abs(positionQty), exec.qty);
      exitQty += closingQty;
      exitNotional += exec.price * closingQty;
      const previousSign = Math.sign(positionQty);
      positionQty += signedQty;

      if (Math.abs(positionQty) <= epsilon) {
        positionQty = 0;
        flush(exec.time);
      } else if (Math.sign(positionQty) !== previousSign) {
        // A single execution closed the old position and opened the reverse.
        // Attribute it to the closed round trip, then seed a new position with
        // the remainder so trade count stays economically correct.
        const remainder = Math.abs(positionQty);
        const openingRatio = remainder / exec.qty;
        const closingFee = exec.fee * (1 - openingRatio);
        fees -= exec.fee * openingRatio;
        tradeExecutions[tradeExecutions.length - 1] = { ...exec, qty: closingQty, fee: closingFee };
        flush(exec.time);
        direction = positionQty > 0 ? "LONG" : "SHORT";
        startedAt = exec.time;
        positionQty = Math.sign(positionQty) * remainder;
        tradeExecutions = [{ ...exec, qty: remainder }];
        entryQty = remainder;
        entryNotional = exec.price * remainder;
        fees = exec.fee * openingRatio;
        realizedPnl = 0;
      }
    }

    if (options.includeIncomplete) flush(executions[executions.length - 1]?.time, true);
  }

  return trades.sort((a, b) => b.exitTime - a.exitTime);
}

module.exports = { aggregateExecutionsIntoTrades, normalizeExecution };
