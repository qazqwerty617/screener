"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROMO_CODE_REGEX = /^[A-Z0-9_-]{3,32}$/;

class PromoError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PromoError";
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function atomicWriteJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().slice(0, 32);
}

function createPromoStore(options = {}) {
  const filePath = options.filePath || path.join(__dirname, "promos.json");
  const clock = typeof options.now === "function" ? options.now : Date.now;

  function read() {
    if (!fs.existsSync(filePath)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch (_) {
      throw new PromoError("PROMO_STORAGE_ERROR", "Промокоды временно недоступны.", 503);
    }
  }

  function write(promos) {
    try { atomicWriteJSON(filePath, promos); } catch (_) {
      throw new PromoError("PROMO_STORAGE_ERROR", "Промокоды временно недоступны.", 503);
    }
  }

  function cleanReservations(promo) {
    const currentTime = clock();
    promo.reservations = Array.isArray(promo.reservations)
      ? promo.reservations.filter(item => item && Number(item.expiresAt) >= currentTime)
      : [];
    return promo;
  }

  function validatePromo(promo) {
    if (!promo || promo.active !== true) {
      throw new PromoError("PROMO_INVALID", "Промокод не найден или отключён.", 404);
    }
    if (!PROMO_CODE_REGEX.test(normalizeCode(promo.code))) {
      throw new PromoError("PROMO_INVALID", "Промокод не найден или отключён.", 404);
    }
    if (!['percent', 'days'].includes(promo.type)) {
      throw new PromoError("PROMO_INVALID", "Промокод настроен некорректно.", 400);
    }
    const value = Number(promo.value);
    if (!Number.isInteger(value) || value < 1 || (promo.type === "percent" && value > 95) || (promo.type === "days" && value > 3650)) {
      throw new PromoError("PROMO_INVALID", "Промокод настроен некорректно.", 400);
    }
    if (promo.expiresAt && Date.parse(promo.expiresAt) <= clock()) {
      throw new PromoError("PROMO_EXPIRED", "Срок действия промокода истёк.", 410);
    }
    cleanReservations(promo);
    const limit = Number(promo.limit);
    if (Number.isFinite(limit) && limit > 0) {
      if (Number(promo.usedCount || 0) + promo.reservations.length >= Math.floor(limit)) {
        throw new PromoError("PROMO_LIMIT_REACHED", "Лимит активаций промокода исчерпан.", 409);
      }
    }
    return promo;
  }

  function buildQuote(promo, baseAmountMinor, baseDays) {
    const discountPercent = promo.type === "percent" ? Number(promo.value) : 0;
    const bonusDays = promo.type === "days" ? Number(promo.value) : 0;
    const amountMinor = discountPercent
      ? Math.max(1, Math.round(baseAmountMinor * (100 - discountPercent) / 100))
      : baseAmountMinor;
    return {
      code: normalizeCode(promo.code),
      type: promo.type,
      value: Number(promo.value),
      originalAmountMinor: baseAmountMinor,
      amountMinor,
      discountPercent,
      bonusDays,
      totalDays: baseDays + bonusDays
    };
  }

  function quote(code, baseAmountMinor, baseDays) {
    const cleanCode = normalizeCode(code);
    if (!PROMO_CODE_REGEX.test(cleanCode)) {
      throw new PromoError("PROMO_INVALID", "Введите корректный промокод.", 400);
    }
    const promos = read();
    const promo = validatePromo(promos.find(item => normalizeCode(item && item.code) === cleanCode));
    return buildQuote(promo, baseAmountMinor, baseDays);
  }

  function reserve(code, invoiceId, userId, expiresAt, baseAmountMinor, baseDays) {
    const cleanCode = normalizeCode(code);
    const promos = read();
    const promo = promos.find(item => normalizeCode(item && item.code) === cleanCode);
    if (promo && Array.isArray(promo.reservations)) {
      const existing = promo.reservations.find(item => item && item.invoiceId === invoiceId);
      if (existing) return buildQuote(promo, baseAmountMinor, baseDays);
    }
    validatePromo(promo);
    promo.reservations.push({ invoiceId, userId, expiresAt });
    write(promos);
    return buildQuote(promo, baseAmountMinor, baseDays);
  }

  function release(invoiceId) {
    const promos = read();
    let changed = false;
    for (const promo of promos) {
      if (!Array.isArray(promo.reservations)) continue;
      const next = promo.reservations.filter(item => item && item.invoiceId !== invoiceId);
      if (next.length !== promo.reservations.length) {
        promo.reservations = next;
        changed = true;
      }
    }
    if (changed) write(promos);
    return changed;
  }

  function consume(invoiceId) {
    const promos = read();
    for (const promo of promos) {
      const usedInvoices = Array.isArray(promo.usedInvoices) ? promo.usedInvoices : [];
      if (usedInvoices.some(item => item && item.invoiceId === invoiceId)) return true;
      const reservations = Array.isArray(promo.reservations) ? promo.reservations : [];
      const reservation = reservations.find(item => item && item.invoiceId === invoiceId);
      if (!reservation) continue;
      promo.reservations = reservations.filter(item => item !== reservation);
      promo.usedCount = Number(promo.usedCount || 0) + 1;
      promo.usedInvoices = [{ invoiceId, userId: reservation.userId, usedAt: new Date(clock()).toISOString() }, ...usedInvoices].slice(0, 5000);
      write(promos);
      return true;
    }
    return false;
  }

  function list() {
    return read().map(promo => {
      const copy = { ...promo };
      delete copy.reservations;
      delete copy.usedInvoices;
      return copy;
    });
  }

  function create(input) {
    const code = normalizeCode(input && input.code);
    const type = input && input.type === "days" ? "days" : input && input.type === "percent" ? "percent" : "";
    const value = Number(input && input.value);
    const limit = Number(input && input.limit);
    if (!PROMO_CODE_REGEX.test(code)) throw new PromoError("PROMO_INVALID", "Код должен содержать 3–32 латинских символа, цифры, - или _.");
    if (!type || !Number.isInteger(value) || value < 1 || (type === "percent" && value > 95) || (type === "days" && value > 3650)) {
      throw new PromoError("PROMO_INVALID", type === "percent" ? "Скидка должна быть от 1% до 95%." : "Количество дней должно быть от 1 до 3650.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new PromoError("PROMO_INVALID", "Лимит должен быть от 1 до 1 000 000.");
    const promos = read();
    if (promos.some(item => normalizeCode(item && item.code) === code)) throw new PromoError("PROMO_EXISTS", "Такой промокод уже существует.", 409);
    const promo = {
      code, type, value, active: true, usedCount: 0, limit,
      createdAt: new Date(clock()).toISOString(),
      expiresAt: input.expiresAt || new Date(clock() + 90 * 24 * 60 * 60 * 1000).toISOString()
    };
    promos.unshift(promo);
    write(promos);
    return { ...promo };
  }

  function toggle(code) {
    const cleanCode = normalizeCode(code);
    const promos = read();
    const promo = promos.find(item => normalizeCode(item && item.code) === cleanCode);
    if (!promo) return null;
    promo.active = !promo.active;
    write(promos);
    return { ...promo };
  }

  return { quote, reserve, release, consume, list, create, toggle };
}

module.exports = { createPromoStore, PromoError, PROMO_CODE_REGEX, normalizeCode };
