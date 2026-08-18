const { createCanvas } = require("@napi-rs/canvas");

/**
 * Server-Side Chart Snapshot Renderer using @napi-rs/canvas
 * Generates crisp 860x480 PNG buffer matching the screener aesthetic.
 */
function renderServerChartSnapshot(candles, meta, signal) {
  const W = 860;
  const H = 480;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#0a0914";
  ctx.fillRect(0, 0, W, H);

  if (!Array.isArray(candles) || candles.length < 5) {
    return canvas.toBuffer("image/png");
  }

  const numCandles = Math.min(candles.length, 120);
  const candleList = candles.slice(-numCandles);
  const lastCandle = candleList[candleList.length - 1];
  const firstCandle = candleList[0];

  const ex = meta?.ex || "BN";
  const sym = meta?.sym || "UNKNOWN";
  const tf = meta?.tf || "15m";
  const exFull = ex === "BN" ? "Binance" : ex === "BB" ? "Bybit" : ex === "OX" ? "OKX" : ex === "BG" ? "Bitget" : ex === "GT" ? "Gate.io" : ex === "MX" ? "MEXC" : ex === "HL" ? "Hyperliquid" : ex === "BX" ? "BingX" : ex === "KC" ? "KuCoin" : ex === "HT" ? "HTX" : ex;

  const TOP = 48;
  const BOTTOM = 32;
  const VOL_H = 65;
  const PR = 80; // right price scale width
  const PW = W - PR;
  const PH = H - TOP - BOTTOM - VOL_H;
  const volY = TOP + PH;

  // ── Header Badges ──
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 15px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(sym.toUpperCase(), 16, 28);

  const symWidth = ctx.measureText(sym.toUpperCase()).width;
  let curBadgeX = 16 + symWidth + 10;

  // Timeframe Badge
  ctx.fillStyle = "#f97316";
  ctx.fillRect(curBadgeX, 13, 34, 18);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(tf.toUpperCase(), curBadgeX + 17, 26);
  curBadgeX += 42;

  // Exchange Badge
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fillRect(curBadgeX, 13, 56, 18);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "600 10.5px sans-serif";
  ctx.fillText(exFull, curBadgeX + 28, 26);
  curBadgeX += 64;

  // Price Change %
  const chgPct = firstCandle.c > 0 ? ((lastCandle.c - firstCandle.o) / firstCandle.o) * 100 : 0;
  const isUp = chgPct >= 0;
  const chgText = (isUp ? "+" : "") + chgPct.toFixed(2) + "%";
  ctx.fillStyle = isUp ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)";
  ctx.fillRect(curBadgeX, 13, 62, 18);
  ctx.fillStyle = isUp ? "#22c55e" : "#ef4444";
  ctx.font = "bold 11px sans-serif";
  ctx.fillText(chgText, curBadgeX + 31, 26);
  ctx.restore();

  // Top Right Title (Clean, NO Emojis)
  ctx.save();
  ctx.textAlign = "right";
  ctx.fillStyle = "#c084fc";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("OBSIDIAN FORMATION ALERT", W - 18, 20);

  const sigType = signal?.type || "trendline";
  const touches = signal?.meta?.touches || 2;
  const dist = signal?.meta?.dist !== undefined ? signal.meta.dist : "0.5";
  let subtitle = `Наклонка: ${touches} касания · до линии ${dist}%`;
  if (sigType === "level") subtitle = `Горизонтальный уровень: ${touches} касания · до линии ${dist}%`;
  else if (sigType === "retest") subtitle = `Подтвержденный ретест: отскок · ${dist}%`;

  ctx.fillStyle = "#94a3b8";
  ctx.font = "500 10.5px sans-serif";
  ctx.fillText(subtitle, W - 18, 34);
  ctx.restore();

  // ── Price Bounds ──
  let minP = Infinity, maxP = -Infinity, maxVol = 0.0001;
  for (const c of candleList) {
    if (c.l < minP) minP = c.l;
    if (c.h > maxP) maxP = c.h;
    if (c.v > maxVol) maxVol = c.v;
  }
  const priceMargin = (maxP - minP) * 0.06 || (minP * 0.01);
  minP -= priceMargin;
  maxP += priceMargin;
  const priceRange = maxP - minP || 1;

  const toY = (p) => TOP + (maxP - p) * (PH / priceRange);
  const toVolY = (v) => volY + VOL_H - (v / maxVol) * (VOL_H - 12);

  const candleStepW = PW / numCandles;
  const candleBodyW = Math.max(2, Math.min(candleStepW * 0.76, candleStepW - 1.2));

  // ── Background Grid ──
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  const numGrid = 6;
  for (let i = 0; i <= numGrid; i++) {
    const p = minP + (priceRange / numGrid) * i;
    const y = toY(p);
    if (y >= TOP && y <= TOP + PH) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(PW, y);
      ctx.stroke();

      // Right price scale label
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(6), PW + 8, y + 3);
    }
  }

  // Volume Separator Line
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.beginPath();
  ctx.moveTo(0, volY);
  ctx.lineTo(W, volY);
  ctx.stroke();

  // ── Candlesticks & Volumes ──
  for (let i = 0; i < numCandles; i++) {
    const c = candleList[i];
    const cx = i * candleStepW + candleStepW / 2;
    const isGreen = c.c >= c.o;
    const col = isGreen ? "#22c55e" : "#ef4444";

    // Wick
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, toY(c.h));
    ctx.lineTo(cx, toY(c.l));
    ctx.stroke();

    // Body
    const yO = toY(c.o);
    const yC = toY(c.c);
    const bTop = Math.min(yO, yC);
    const bH = Math.max(1.5, Math.abs(yC - yO));
    ctx.fillStyle = col;
    ctx.fillRect(cx - candleBodyW / 2, bTop, candleBodyW, bH);

    // Volume Bar
    const vTop = toVolY(c.v);
    ctx.fillStyle = isGreen ? "rgba(34, 197, 94, 0.35)" : "rgba(239, 68, 68, 0.35)";
    ctx.fillRect(cx - candleBodyW / 2, vTop, candleBodyW, volY + VOL_H - vTop);
  }

  // ── Formation Overlay ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, TOP, PW, PH);
  ctx.clip();

  if (sigType === "trendline") {
    let x1, y1, x2, y2;
    const offset = candles.length - numCandles;
    const p1Idx = signal?.meta?.p1Idx !== undefined ? signal.meta.p1Idx - offset : -1;
    const p2Idx = signal?.meta?.p2Idx !== undefined ? signal.meta.p2Idx - offset : -1;
    const p1Price = signal?.meta?.p1Price;
    const p2Price = signal?.meta?.p2Price;

    if (p1Idx >= 0 && p2Idx >= 0 && p1Price && p2Price && p2Idx > p1Idx) {
      x1 = p1Idx * candleStepW + candleStepW / 2;
      y1 = toY(p1Price);
      x2 = p2Idx * candleStepW + candleStepW / 2;
      y2 = toY(p2Price);
    } else {
      // Clean fallback: find swing extrema on the visible candleList
      const isAsc = signal?.direction === "long" || signal?.meta?.tlType === "asc";
      const swings = [];
      for (let i = 2; i < numCandles - 2; i++) {
        if (isAsc) {
          if (candleList[i].l <= candleList[i - 1].l && candleList[i].l <= candleList[i + 1].l) {
            swings.push({ idx: i, p: candleList[i].l });
          }
        } else {
          if (candleList[i].h >= candleList[i - 1].h && candleList[i].h >= candleList[i + 1].h) {
            swings.push({ idx: i, p: candleList[i].h });
          }
        }
      }
      if (swings.length >= 2) {
        const s1 = swings[Math.max(0, swings.length - 3)];
        const s2 = swings[swings.length - 1];
        x1 = s1.idx * candleStepW + candleStepW / 2;
        y1 = toY(s1.p);
        x2 = s2.idx * candleStepW + candleStepW / 2;
        y2 = toY(s2.p);
      } else {
        x1 = Math.max(0, numCandles - 30) * candleStepW + candleStepW / 2;
        y1 = toY(isAsc ? lastCandle.l : lastCandle.h);
        x2 = (numCandles - 1) * candleStepW + candleStepW / 2;
        y2 = toY(signal?.price || lastCandle.c);
      }
    }

    if (x2 > x1) {
      const slope = (y2 - y1) / (x2 - x1);
      const endX = (numCandles - 1) * candleStepW + candleStepW / 2;
      const endY = y1 + slope * (endX - x1);

      ctx.strokeStyle = "#eab308";
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      // Touch Points
      [ { x: x1, y: y1 }, { x: x2, y: y2 } ].forEach(pt => {
        ctx.fillStyle = "#eab308";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }
  } else if (sigType === "level" || sigType === "retest") {
    const lvlPrice = signal?.price || lastCandle.c;
    const ly = toY(lvlPrice);

    ctx.strokeStyle = sigType === "retest" ? "#38bdf8" : "#f59e0b";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(PW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // ── Current Price Badge on Right Scale ──
  const curY = toY(lastCandle.c);
  const isCurUp = lastCandle.c >= lastCandle.o;
  ctx.fillStyle = isCurUp ? "#22c55e" : "#ef4444";
  ctx.fillRect(PW + 2, curY - 10, PR - 4, 20);
  ctx.fillStyle = "#000000";
  ctx.font = "bold 10.5px monospace";
  ctx.textAlign = "center";
  const pStr = lastCandle.c >= 100 ? lastCandle.c.toFixed(2) : lastCandle.c >= 1 ? lastCandle.c.toFixed(4) : lastCandle.c.toFixed(6);
  ctx.fillText(pStr, PW + PR / 2, curY + 4);

  // ── Bottom Time Labels ──
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  const stepIdx = Math.floor(numCandles / 5);
  for (let i = 0; i < numCandles; i += stepIdx) {
    const c = candleList[i];
    if (!c || !c.t) continue;
    const d = new Date(c.t + 3 * 3600000); // UTC+3
    const dStr = d.toISOString().substring(8, 10) + "." + d.toISOString().substring(5, 7) + " " + d.toISOString().substring(11, 16);
    const x = i * candleStepW + candleStepW / 2;
    ctx.fillText(dStr, x, H - 10);
  }

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderServerChartSnapshot
};
