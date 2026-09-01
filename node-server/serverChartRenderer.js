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

  // 1. Genuine 24h Change
  const rawChg = (meta && meta.chg !== undefined && typeof meta.chg === "number" && !isNaN(meta.chg))
    ? meta.chg
    : (signal && signal.meta && signal.meta.pctChange !== undefined && !isNaN(signal.meta.pctChange))
    ? signal.meta.pctChange
    : (firstCandle.o > 0 ? ((lastCandle.c - firstCandle.o) / firstCandle.o) * 100 : 0);
  const isChgUp = rawChg >= 0;
  const chgText = (isChgUp ? "+" : "") + Number(rawChg).toFixed(2) + "%";

  // 2. Genuine 24h Volume
  const rawVol = (meta && meta.vol !== undefined && Number(meta.vol) > 0)
    ? Number(meta.vol)
    : (signal && signal.meta && signal.meta.vol !== undefined && Number(signal.meta.vol) > 0)
    ? Number(signal.meta.vol)
    : null;

  let vol24Str;
  if (rawVol !== null && rawVol > 0) {
    if (rawVol >= 1e9) vol24Str = `$${(rawVol / 1e9).toFixed(2)}B`;
    else if (rawVol >= 1e6) vol24Str = `$${(rawVol / 1e6).toFixed(2)}M`;
    else if (rawVol >= 1e3) vol24Str = `$${(rawVol / 1e3).toFixed(1)}K`;
    else vol24Str = `$${rawVol.toFixed(0)}`;
  } else {
    let sumVol = 0;
    for (const c of candleList) sumVol += (c.v || 0);
    if (sumVol >= 1e9) vol24Str = `$${(sumVol / 1e9).toFixed(2)}B`;
    else if (sumVol >= 1e6) vol24Str = `$${(sumVol / 1e6).toFixed(2)}M`;
    else if (sumVol >= 1e3) vol24Str = `$${(sumVol / 1e3).toFixed(1)}K`;
    else vol24Str = `$${sumVol.toFixed(0)}`;
  }

  // 3. Genuine NATR
  let natrVal = 0;
  if (meta && meta.natr !== undefined && Number.isFinite(meta.natr) && meta.natr > 0) {
    natrVal = Number(meta.natr);
  } else {
    let lH = 0, lL = Infinity;
    for (const c of candleList) { if (c.h > lH) lH = c.h; if (c.l < lL) lL = c.l; }
    natrVal = lastCandle.c > 0 && lH >= lL ? ((lH - lL) / lastCandle.c) * 100 : 0;
  }
  natrVal = Math.max(0, Math.min(100, natrVal));
  const natrText = natrVal.toFixed(1) + "%";

  // 4. Genuine Funding Rate
  let fundText = "+0.0100%";
  let fundCol = "#fbbf24";
  if (meta && meta.funding !== undefined && meta.funding !== null && Number.isFinite(Number(meta.funding))) {
    const rawF = Number(meta.funding);
    const fundPct = Math.abs(rawF) < 0.01 ? (rawF * 100) : rawF;
    fundText = (fundPct >= 0 ? "+" : "") + fundPct.toFixed(4) + "%";
    fundCol = fundPct >= 0 ? "#fbbf24" : "#f87171";
  }

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
  renderStatPill("NATR", natrText, "#a855f7");
  renderStatPill("ФАНДИНГ", fundText, fundCol);


  // Top Right Title (Clean, Professional HUD)
  ctx.textAlign = "right";
  const sigType = signal?.type || "trendline";
  const isPumpSig = sigType === "pump";
  const isDumpSig = sigType === "dump";
  const isPriceAlert = sigType === "price_level" || sigType === "price";

  if (isPumpSig) {
    ctx.fillStyle = "#22c55e";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText("⚡ OBSIDIAN PUMP RADAR", W - 22, 20);
    ctx.font = "600 11px sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    const pctStr = signal?.meta?.pctChange ? `+${signal.meta.pctChange.toFixed(2)}%` : "IMPULSE UP";
    ctx.fillText(`Импульс цены: ${pctStr}`, W - 22, 36);
  } else if (isDumpSig) {
    ctx.fillStyle = "#ef4444";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText("⚡ OBSIDIAN DUMP RADAR", W - 22, 20);
    ctx.font = "600 11px sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    const pctStr = signal?.meta?.pctChange ? `${signal.meta.pctChange.toFixed(2)}%` : "IMPULSE DOWN";
    ctx.fillText(`Сброс цены: ${pctStr}`, W - 22, 36);
  } else if (isPriceAlert) {
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText("🔔 OBSIDIAN PRICE ALERT", W - 22, 20);
    ctx.font = "600 11px sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.fillText("Достигнут целевой уровень цены", W - 22, 36);
  } else {
    ctx.fillStyle = "#c084fc";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("OBSIDIAN FORMATION ALERT", W - 22, 20);
    ctx.font = "600 11px sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    const touches = signal?.meta?.touches || 2;
    const subText = sigType === "trendline" ? `Наклонная линия · ${touches} касания` : sigType === "level" ? `Уровень S/R · ${touches} касания` : "Подтвержденный ретест";
    ctx.fillText(subText, W - 22, 36);
  }
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

  const effectiveNum = Math.max(numCandles, 55);
  const candleStepW = PW / effectiveNum;
  const candleBodyW = Math.max(1.8, Math.min(13, candleStepW * 0.76));
  const xOffset = PW - (numCandles * candleStepW);
  const toX = (idx) => xOffset + idx * candleStepW + candleStepW / 2;

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
    const cx = toX(i);
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

  const lastCandleX = toX(numCandles - 1);

  if (sigType === "trendline") {
    const endPrice = Number(signal?.price) || Number(signal?.meta?.endPrice) || lastCandle.c;
    const offset = candles.length - numCandles;
    const p1Price = signal?.meta?.p1Price;
    const p2Price = signal?.meta?.p2Price;
    const p1Idx = signal?.meta?.p1Idx;
    const p2Idx = signal?.meta?.p2Idx;

    let slope = Number(signal?.meta?.slope) || 0;
    if (p1Price !== undefined && p2Price !== undefined && p2Idx !== undefined && p1Idx !== undefined && p2Idx !== p1Idx) {
      slope = (p2Price - p1Price) / (p2Idx - p1Idx);
    }

    const rawP1 = p1Idx !== undefined ? p1Idx - offset : -1;
    const startIdx = Math.max(0, rawP1 >= 0 ? rawP1 : 0);

    const startPrice = endPrice - slope * (numCandles - 1 - startIdx);
    const x1 = toX(startIdx);
    const y1 = toY(startPrice);

    const lineEndX = lastCandleX + candleStepW * 3;
    const lineEndY = toY(endPrice + slope * 3);

    ctx.strokeStyle = "#eab308";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(lineEndX, lineEndY);
    ctx.stroke();

    // Draw all genuine touch dots along the trendline
    const touchList = Array.isArray(signal?.meta?.swingIndices) && signal.meta.swingIndices.length > 0
      ? signal.meta.swingIndices
      : [signal?.meta?.p1Idx, signal?.meta?.p2Idx].filter(idx => idx !== undefined);

    touchList.forEach(tIdx => {
      const localIdx = tIdx - offset;
      if (localIdx >= startIdx && localIdx < numCandles) {
        const dotX = toX(localIdx);
        const dotPrice = endPrice - slope * (numCandles - 1 - localIdx);
        const dotY = toY(dotPrice);
        ctx.fillStyle = "#eab308";
        ctx.beginPath();
        ctx.arc(dotX, dotY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
  } else if (sigType === "level" || sigType === "retest" || sigType === "price_level" || sigType === "price") {
    const lvlPrice = signal?.price || lastCandle.c;
    const ly = toY(lvlPrice);
    const offset = candles.length - numCandles;
    const originIdx = Number.isFinite(signal?.meta?.swingIdx) ? Math.max(0, signal.meta.swingIdx - offset) : Math.max(0, numCandles - 45);
    const originX = toX(originIdx);

    const isRetest = sigType === "retest" || sigType === "price_level" || sigType === "price";
    const lineColor = isRetest ? "#38bdf8" : "#f59e0b";

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.6;
    ctx.setLineDash(isRetest ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(originX, ly);
    ctx.lineTo(PW, ly);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw all genuine touch dots along the horizontal level
    const touchList = Array.isArray(signal?.meta?.touchIndices) && signal.meta.touchIndices.length > 0
      ? signal.meta.touchIndices
      : (Number.isFinite(signal?.meta?.swingIdx) ? [signal.meta.swingIdx] : []);

    ctx.fillStyle = lineColor;
    for (const tIdx of touchList) {
      const localIdx = tIdx - offset;
      if (localIdx >= 0 && localIdx < numCandles) {
        const dotX = toX(localIdx);
        ctx.beginPath();
        ctx.arc(dotX, ly, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
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

  // ── Bottom Time Labels & Ticks (Clean Round Time intervals + UTC+3 tag) ──
  const timeY = H - BTM_TIME / 2;
  const tfLow = tf.toLowerCase();

  // Determine ideal milestone time interval in milliseconds
  let intervalMs = 3600000; // 1 hour default
  if (tfLow === "1m") intervalMs = 15 * 60000; // 15 mins
  else if (tfLow === "3m" || tfLow === "5m") intervalMs = 30 * 60000; // 30 mins
  else if (tfLow === "15m" || tfLow === "30m") intervalMs = 2 * 3600000; // 2 hours
  else if (tfLow === "1h") intervalMs = 4 * 3600000; // 4 hours
  else if (tfLow === "4h") intervalMs = 8 * 3600000; // 8 hours
  else if (tfLow === "1d") intervalMs = 3 * 86400000; // 3 days

  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.font = "10.5px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let lastDrawnX = -100;
  for (let i = 0; i < numCandles; i++) {
    const c = candleList[i];
    if (!c || !c.t) continue;
    const t = c.t;
    const prevT = i > 0 ? candleList[i - 1].t : 0;
    const curIntervalBucket = Math.floor(t / intervalMs);
    const prevIntervalBucket = Math.floor(prevT / intervalMs);

    if (curIntervalBucket !== prevIntervalBucket || (i === 0 && numCandles < 30)) {
      const cx = toX(i);
      if (cx >= 45 && cx <= PW - 45 && (cx - lastDrawnX) >= 65) {
        const d = new Date(t + 3 * 3600000); // UTC+3
        const hh = String(d.getUTCHours()).padStart(2, "0");
        const mm = String(d.getUTCMinutes()).padStart(2, "0");
        const day = String(d.getUTCDate()).padStart(2, "0");
        const month = String(d.getUTCMonth() + 1).padStart(2, "0");

        let timeStr = `${hh}:${mm}`;
        if (tfLow === "1d") timeStr = `${day}.${month}`;
        else if (hh === "00" && mm === "00") timeStr = `${day}.${month}`;

        // Small vertical tick mark on time bar
        ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, TOP + PH + VOL_H);
        ctx.lineTo(cx, TOP + PH + VOL_H + 4);
        ctx.stroke();

        ctx.fillText(timeStr, cx, timeY);
        lastDrawnX = cx;
      }
    }
  }

  // UTC+3 Badge in bottom-right corner matching screener chart
  const tzX = PW + 6;
  const tzY = H - BTM_TIME + 4;
  const tzW = PR - 12;
  const tzH = BTM_TIME - 8;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(tzX, tzY, tzW, tzH, 3.5) : ctx.rect(tzX, tzY, tzW, tzH);
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("UTC+3", tzX + tzW / 2, tzY + tzH / 2);
  ctx.restore();

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderServerChartSnapshot
};
