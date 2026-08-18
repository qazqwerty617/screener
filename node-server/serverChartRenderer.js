const { createCanvas } = require("@napi-rs/canvas");

/**
 * Server-Side Chart Snapshot Renderer using @napi-rs/canvas
 * Generates identical Ultra-HD 1200x680 PNG buffer matching the screener HUD aesthetic.
 */
function renderServerChartSnapshot(candles, meta, signal) {
  const W = 1200;
  const H = 680;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Deep Obsidian Background
  ctx.fillStyle = "#0c0e14";
  ctx.fillRect(0, 0, W, H);

  if (!Array.isArray(candles) || candles.length < 5) {
    return canvas.toBuffer("image/png");
  }

  const numCandles = Math.min(candles.length, 140);
  const candleList = candles.slice(-numCandles);
  const lastCandle = candleList[candleList.length - 1];
  const firstCandle = candleList[0];

  const ex = meta?.ex || "BN";
  const sym = (meta?.sym || "UNKNOWN").toUpperCase();
  const tf = (meta?.tf || "15m").toUpperCase();
  const exFull = ex === "BN" ? "Binance" : ex === "BB" ? "Bybit" : ex === "OX" ? "OKX" : ex === "BG" ? "Bitget" : ex === "GT" ? "Gate.io" : ex === "MX" ? "MEXC" : ex === "HL" ? "Hyperliquid" : ex === "BX" ? "BingX" : ex === "KC" ? "KuCoin" : ex === "HT" ? "HTX" : ex;

  const TOP = 52;
  const PR = 105;
  const PW = W - PR;
  const BTM_TIME = 28;
  const VOL_H = 105;
  const PH = H - TOP - VOL_H - BTM_TIME;
  const volY = TOP + PH;

  // ── Header (Symbol + Timeframe Badge + Stats HUD + Alert Title) ──
  ctx.save();
  ctx.font = "bold 20px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(sym, 22, 26);
  const symW = ctx.measureText(sym).width;

  // Timeframe Badge
  const tfColors = { "1M": "#38bdf8", "3M": "#38bdf8", "5M": "#22c55e", "15M": "#a855f7", "30M": "#ec4899", "1H": "#f59e0b", "4H": "#f97316", "1D": "#e11d48" };
  const tfBg = tfColors[tf] || "#a855f7";
  const badgeX = 22 + symW + 12;
  const tfBadgeW = Math.max(36, tf.length * 9 + 16);

  ctx.fillStyle = tfBg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(badgeX, 14, tfBadgeW, 23, 5) : ctx.rect(badgeX, 14, tfBadgeW, 23);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 11.5px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(tf, badgeX + tfBadgeW / 2, 26);

  // ── Coin Stats HUD Card (Изм, Объем, NATR, Фандинг) ──
  const hudX = badgeX + tfBadgeW + 16;
  const chg24 = firstCandle.o > 0 ? ((lastCandle.c - firstCandle.o) / firstCandle.o) * 100 : 0;
  const isChgUp = chg24 >= 0;
  const chgText = (isChgUp ? "+" : "") + chg24.toFixed(2) + "%";

  let sumVol = 0;
  for (const c of candleList) sumVol += (c.v || 0) * (c.c || 1);
  const vol24Str = sumVol >= 1e9 ? `$${(sumVol / 1e9).toFixed(1)}B` : sumVol >= 1e6 ? `$${(sumVol / 1e6).toFixed(1)}M` : `$${(sumVol / 1e3).toFixed(0)}K`;

  let lH = 0, lL = Infinity;
  for (const c of candleList) { if (c.h > lH) lH = c.h; if (c.l < lL) lL = c.l; }
  const natrVal = lastCandle.c > 0 && lH >= lL ? Math.max(0, Math.min(100, ((lH - lL) / lastCandle.c) * 100 * 0.45)) : 12.5;

  let curStatX = hudX;
  const renderStatPill = (label, val, valCol) => {
    ctx.font = "600 10.5px sans-serif";
    const lblW = ctx.measureText(label).width;
    ctx.font = "bold 11px sans-serif";
    const valW = ctx.measureText(val).width;
    const pillW = lblW + valW + 18;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(curStatX, 14, pillW, 23, 5) : ctx.rect(curStatX, 14, pillW, 23);
    ctx.fillStyle = "rgba(255, 255, 255, 0.055)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.font = "600 10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, curStatX + 7, 26);

    ctx.fillStyle = valCol;
    ctx.font = "bold 11px monospace";
    ctx.fillText(val, curStatX + 7 + lblW + 4, 26);
    ctx.restore();

    curStatX += pillW + 8;
  };

  renderStatPill("ИЗМ", chgText, isChgUp ? "#22c55e" : "#ef4444");
  renderStatPill("ОБЪЕМ", vol24Str, "#ffffff");
  renderStatPill("NATR", natrVal.toFixed(1) + "%", "#a855f7");
  renderStatPill("ФАНДИНГ", "+0.0100%", "#fbbf24");

  // Top Right Title (Clean, NO Emojis)
  ctx.textAlign = "right";
  ctx.fillStyle = "#c084fc";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("OBSIDIAN FORMATION ALERT", W - 22, 20);

  const sigType = signal?.type || "trendline";
  const touches = signal?.meta?.touches || 2;
  const dist = signal?.meta?.dist !== undefined ? signal.meta.dist : "0.5";
  let subtitle = `Наклонка: ${touches} касания · до линии ${dist}%`;
  if (sigType === "level") subtitle = `Горизонтальный уровень: ${touches} касания · до линии ${dist}%`;
  else if (sigType === "retest") subtitle = `Подтвержденный ретест: отскок · ${dist}%`;

  ctx.fillStyle = "#94a3b8";
  ctx.font = "500 10.5px sans-serif";
  ctx.fillText(subtitle, W - 22, 34);
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
  const toVolY = (v) => volY + VOL_H - (v / maxVol) * (VOL_H - 15);

  const candleStepW = PW / numCandles;
  const candleBodyW = Math.max(1.8, Math.min(candleStepW * 0.76, candleStepW - 1.2));

  // ── Background Grid ──
  const gridStep = priceRange / 7;
  let gp = Math.ceil(minP / gridStep) * gridStep;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  while (gp <= maxP) {
    const y = toY(gp);
    if (y >= TOP && y <= TOP + PH) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(PW, y);
      ctx.stroke();
    }
    gp += gridStep;
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
    const isUp = c.c >= c.o;
    const col = isUp ? "#22c55e" : "#ef4444";

    // Wick
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.1;
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
    ctx.fillStyle = isUp ? "rgba(34, 197, 94, 0.45)" : "rgba(239, 68, 68, 0.45)";
    ctx.fillRect(cx - candleBodyW / 2, vTop, candleBodyW, volY + VOL_H - vTop);
  }

  // ── Formation Highlight ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, TOP, PW, PH);
  ctx.clip();

  const lastCandleX = (numCandles - 1) * candleStepW + candleStepW / 2;

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
      // Find clean tangent swing extrema
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
        x1 = Math.max(0, numCandles - 35) * candleStepW + candleStepW / 2;
        y1 = toY(isAsc ? lastCandle.l : lastCandle.h);
        x2 = (numCandles - 1) * candleStepW + candleStepW / 2;
        y2 = toY(signal?.price || lastCandle.c);
      }
    }

    if (x2 > x1) {
      const slope = (y2 - y1) / (x2 - x1);
      const lineEndX = lastCandleX + candleStepW * 3;
      const lineEndY = y1 + slope * (lineEndX - x1);

      ctx.strokeStyle = "#eab308";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(lineEndX, lineEndY);
      ctx.stroke();

      // Subtle touch dots
      [ { x: x1, y: y1 }, { x: x2, y: y2 } ].forEach(pt => {
        ctx.fillStyle = "#eab308";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.8, 0, Math.PI * 2);
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
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(PW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // ── Bottom Semi-Transparent HUD Card (Obsidian Formation Scanner) ──
  const hudW = 340;
  const hudH = 175;
  const hudCardX = (PW - hudW) / 2;
  const hudCardY = H - hudH - 24;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(hudCardX, hudCardY, hudW, hudH, 8) : ctx.rect(hudCardX, hudCardY, hudW, hudH);
  ctx.fillStyle = "rgba(10, 12, 18, 0.88)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 11.5px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  let typeName = "Наклонный уровень (Наклонка)";
  if (sigType === "level") typeName = "Горизонтальный уровень (Горизонталка)";
  else if (sigType === "retest") typeName = "Подтвержденный ретест (Ретест)";

  let lineY = hudCardY + 12;
  ctx.fillText(`Сигнал формации: ${typeName}`, hudCardX + 14, lineY);
  lineY += 18;

  ctx.font = "500 10.5px sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.fillText(`• Монета: ${sym} (${exFull})`, hudCardX + 14, lineY); lineY += 16;
  ctx.fillText(`• Таймфрейм: ${tf.toLowerCase()}`, hudCardX + 14, lineY); lineY += 16;
  ctx.fillText(`• Касания: ${touches} касания`, hudCardX + 14, lineY); lineY += 16;
  ctx.fillText(`• Дистанция: ${dist}% до формации`, hudCardX + 14, lineY); lineY += 16;
  ctx.fillText(`• Текущая цена: $${lastCandle.c >= 100 ? lastCandle.c.toFixed(2) : lastCandle.c >= 1 ? lastCandle.c.toFixed(4) : lastCandle.c.toFixed(6)}`, hudCardX + 14, lineY); lineY += 16;
  ctx.fillText(`• Объем 24ч: ${vol24Str}`, hudCardX + 14, lineY); lineY += 16;

  const nowD = new Date(Date.now() + 3 * 3600000);
  const timeStr = nowD.toISOString().substring(11, 19);
  const dateStr = nowD.toISOString().substring(8, 10) + "." + nowD.toISOString().substring(5, 7);
  ctx.fillText(`• Время: ${dateStr} ${timeStr}`, hudCardX + 14, lineY); lineY += 20;

  ctx.font = "bold 10px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Obsidian Formation Scanner", hudCardX + 14, lineY);
  ctx.restore();

  // ── Live / Last Candle Price Badge on Right Scale ──
  const liveY = toY(lastCandle.c);
  const isUp = lastCandle.c >= lastCandle.o;
  const bH = 22;
  const bW = PR - 8;
  const bX = PW + 4;
  const bY = liveY - bH / 2;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bX, bY, bW, bH, 5) : ctx.rect(bX, bY, bW, bH);
  ctx.fillStyle = "#131722";
  ctx.fill();
  ctx.strokeStyle = isUp ? "#22c55e" : "#ef4444";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const pStr = lastCandle.c >= 100 ? lastCandle.c.toFixed(2) : lastCandle.c >= 1 ? lastCandle.c.toFixed(4) : lastCandle.c.toFixed(6);
  ctx.fillText(pStr, bX + bW / 2, liveY);
  ctx.restore();

  // ── Price Scale Labels (Right) ──
  gp = Math.ceil(minP / gridStep) * gridStep;
  ctx.font = "10.5px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  while (gp <= maxP) {
    const y = toY(gp);
    if (y >= TOP + 12 && y <= TOP + PH - 12) {
      if (Math.abs(liveY - y) >= 16) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
        ctx.fillText(gp >= 100 ? gp.toFixed(2) : gp >= 1 ? gp.toFixed(4) : gp.toFixed(6), PW + 8, y);
      }
    }
    gp += gridStep;
  }

  // ── Bottom Time Labels ──
  const timeY = H - BTM_TIME / 2;
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.font = "10.5px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const timeStep = Math.floor(numCandles / 7);
  for (let i = Math.floor(timeStep / 2); i < numCandles; i += timeStep) {
    const c = candleList[i];
    if (c && c.t) {
      const d = new Date(c.t + 3 * 3600000);
      const timeStr = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      const dateStr = `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const label = tf.includes("D") ? dateStr : `${dateStr} ${timeStr}`;
      const tx = i * candleStepW + candleStepW / 2;
      if (tx > 40 && tx < PW - 40) {
        ctx.fillText(label, tx, timeY);
      }
    }
  }

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderServerChartSnapshot
};
