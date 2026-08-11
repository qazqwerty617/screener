"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const defaultUserStore = require("./userStore");

const TRC20_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_ADDRESS_REGEX = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const INVOICE_ID_REGEX = /^inv_[A-Za-z0-9_-]{32}$/;
const CRYPTO_PAY_INVOICE_ID_REGEX = /^\d{1,24}$/;
const INVOICE_TTL_MS = 20 * 60 * 1000;
const PAYMENT_GRACE_MS = 2 * 60 * 1000;
const STATUS_CHECK_INTERVAL_MS = 5 * 1000;
const MAX_WEBHOOK_AGE_MS = 15 * 60 * 1000;

const TARIF_PRICES = Object.freeze({
  "1m": Object.freeze({ usd: 30, days: 30, title: "1 месяц PRO" }),
  "3m": Object.freeze({ usd: 80, days: 90, title: "3 месяца PRO" }),
  "12m": Object.freeze({ usd: 250, days: 365, title: "12 месяцев PRO" }),
  "lifetime": Object.freeze({ usd: 490, days: 9999, title: "Бессрочная PRO" })
});

class PaymentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function safeString(value, maxLength = 512) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function decimalToMinor(value, scale = 2) {
  const text = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match || scale !== 2) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(2, "0"));
  const minor = whole * 100n + fraction;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

function minorToDecimal(minor) {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid minor amount");
  const whole = Math.floor(minor / 100);
  const fraction = String(minor % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
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
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Payment data file must contain an array: ${filePath}`);
  }
  return parsed;
}

function createPaymentGateway(options = {}) {
  const env = options.env || process.env;
  const gatewayUserStore = options.userStore || defaultUserStore;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const dataDir = options.dataDir || safeString(env.PAYMENT_DATA_DIR, 2048) || __dirname;
  const paymentsFile = options.paymentsFile || path.join(dataDir, "payments.json");
  const invoicesFile = options.invoicesFile || path.join(dataDir, "payment_invoices.json");

  if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required");

  const cryptoPayToken = safeString(env.CRYPTO_PAY_API_TOKEN, 512);
  const cryptoPayTestnet = String(env.CRYPTO_PAY_TESTNET || "").toLowerCase() === "true";
  const cryptoPayApiBase = cryptoPayTestnet
    ? "https://testnet-pay.crypt.bot/api"
    : "https://pay.crypt.bot/api";
  const webhookPathSecret = safeString(env.CRYPTO_PAY_WEBHOOK_SECRET, 512);
  const tronGridApiKey = safeString(env.TRONGRID_API_KEY, 512);

  const wallets = {
    trc20: safeString(env.PAYMENT_TRC20_WALLET, 128)
  };
  if (wallets.trc20 && !TRON_ADDRESS_REGEX.test(wallets.trc20)) {
    throw new Error("PAYMENT_TRC20_WALLET is not a valid TRON address");
  }
  if (webhookPathSecret && webhookPathSecret.length < 32) {
    throw new Error("CRYPTO_PAY_WEBHOOK_SECRET must contain at least 32 characters");
  }

  let payments = loadArray(paymentsFile);
  const invoices = new Map();
  const userActiveInvoices = new Map();
  const amountReservations = new Map();
  const processedTransactionIds = new Set();
  const processingLocks = new Set();
  const verificationPromises = new Map();

  for (const payment of payments) {
    if (payment && typeof payment.txId === "string" && payment.txId) {
      processedTransactionIds.add(payment.txId);
    }
  }

  const loadedInvoices = loadArray(invoicesFile);
  for (const invoice of loadedInvoices) {
    if (!invoice || !INVOICE_ID_REGEX.test(String(invoice.id || ""))) continue;
    invoices.set(invoice.id, invoice);
  }

  function persistPayments() {
    atomicWriteJSON(paymentsFile, payments);
  }

  function persistInvoices() {
    const retentionCutoff = clock() - 90 * 24 * 60 * 60 * 1000;
    for (const [id, invoice] of invoices) {
      const createdMs = Date.parse(invoice.createdAt || "");
      if (
        Number.isFinite(createdMs) &&
        createdMs < retentionCutoff &&
        ["success", "expired", "cancelled"].includes(invoice.status)
      ) {
        invoices.delete(id);
      }
    }
    atomicWriteJSON(invoicesFile, Array.from(invoices.values()));
  }

  function releaseInvoiceReservation(invoice) {
    if (invoice && invoice.reservationKey && amountReservations.get(invoice.reservationKey) === invoice.id) {
      amountReservations.delete(invoice.reservationKey);
    }
    if (invoice && userActiveInvoices.get(invoice.userId) === invoice.id) {
      userActiveInvoices.delete(invoice.userId);
    }
  }

  function rebuildActiveState() {
    for (const invoice of invoices.values()) {
      if (!["pending", "processing"].includes(invoice.status)) continue;
      userActiveInvoices.set(invoice.userId, invoice.id);
      if (invoice.reservationKey) amountReservations.set(invoice.reservationKey, invoice.id);
    }
  }
  rebuildActiveState();

  function cleanupExpiredInvoices() {
    const currentTime = clock();
    let changed = false;
    for (const invoice of invoices.values()) {
      if (
        ["pending", "processing"].includes(invoice.status) &&
        Number.isFinite(invoice.expiresAt) &&
        invoice.expiresAt + PAYMENT_GRACE_MS < currentTime &&
        Number(invoice.finalVerificationAt) >= invoice.expiresAt + PAYMENT_GRACE_MS
      ) {
        invoice.status = "expired";
        invoice.updatedAt = new Date(currentTime).toISOString();
        releaseInvoiceReservation(invoice);
        changed = true;
      }
    }
    if (changed) persistInvoices();
  }

  if (options.startCleanupTimer !== false) {
    const reconcileTimer = setInterval(() => {
      reconcileExpiredInvoices().catch(error => {
        console.error("[PAYMENT RECONCILIATION] Failed:", error.message);
      });
    }, 30 * 1000);
    reconcileTimer.unref();
    const initialReconciliation = setTimeout(() => {
      reconcileExpiredInvoices().catch(error => {
        console.error("[PAYMENT RECONCILIATION] Initial check failed:", error.message);
      });
    }, 1000);
    initialReconciliation.unref();
  }

  function getAvailableMethods() {
    const methods = [];
    if (TRON_ADDRESS_REGEX.test(wallets.trc20)) methods.push("trc20");
    if (cryptoPayToken) methods.push("cryptobot");
    return methods;
  }

  function getPublicConfig() {
    return {
      methods: getAvailableMethods(),
      tariffs: Object.entries(TARIF_PRICES).map(([id, tariff]) => ({
        id,
        amount: minorToDecimal(tariff.usd * 100),
        days: tariff.days,
        title: tariff.title
      }))
    };
  }

  function allocateFloatingCents(network, basePriceUsd) {
    for (let cents = 1; cents <= 99; cents++) {
      const amountMinor = basePriceUsd * 100 + cents;
      const amountStr = minorToDecimal(amountMinor);
      const key = `${network}:${amountStr}`;
      if (!amountReservations.has(key)) return { amountMinor, amountStr, key };
    }
    throw new PaymentError(
      "PAYMENT_CAPACITY_REACHED",
      "Все безопасные суммы временно заняты. Повторите попытку позднее.",
      503
    );
  }

  function presentInvoice(invoice) {
    const output = {
      id: invoice.id,
      planId: invoice.planId,
      planTitle: invoice.planTitle,
      method: invoice.method,
      status: invoice.status,
      amountStr: invoice.amountStr,
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt
    };
    if (invoice.address) output.address = invoice.address;
    if (invoice.qrData) output.qrData = invoice.qrData;
    if (invoice.payUrl) output.payUrl = invoice.payUrl;
    return output;
  }

  async function fetchJson(url, requestOptions = {}, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, { ...requestOptions, signal: controller.signal });
      const rawText = await response.text();
      if (rawText.length > 2 * 1024 * 1024) throw new Error("Provider response is too large");
      let data;
      try { data = JSON.parse(rawText); } catch (_) { throw new Error("Provider returned invalid JSON"); }
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function cryptoPayRequest(method, body) {
    if (!cryptoPayToken) {
      throw new PaymentError("METHOD_UNAVAILABLE", "Crypto Pay временно недоступен.", 503);
    }
    const data = await fetchJson(`${cryptoPayApiBase}/${method}`, {
      method: "POST",
      headers: {
        "Crypto-Pay-API-Token": cryptoPayToken,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body || {})
    });
    if (!data || data.ok !== true) throw new Error(`Crypto Pay rejected ${method}`);
    return data.result;
  }

  async function createInvoice(userId, planId = "1m", method = "trc20") {
    cleanupExpiredInvoices();
    const user = gatewayUserStore.findUser(userId);
    if (!user || user.id !== userId) {
      throw new PaymentError("USER_NOT_FOUND", "Пользователь не найден.", 404);
    }
    if (!Object.prototype.hasOwnProperty.call(TARIF_PRICES, planId)) {
      throw new PaymentError("INVALID_PLAN", "Неизвестный тариф.", 400);
    }
    if (!getAvailableMethods().includes(method)) {
      throw new PaymentError("METHOD_UNAVAILABLE", "Этот способ оплаты не настроен.", 503);
    }

    const existingId = userActiveInvoices.get(user.id);
    const existing = existingId ? invoices.get(existingId) : null;
    if (existing && ["pending", "processing"].includes(existing.status) && existing.expiresAt > clock()) {
      if (existing.planId === planId && existing.method === method) return presentInvoice(existing);
      throw new PaymentError(
        "ACTIVE_INVOICE_EXISTS",
        "У вас уже есть активный счёт. Дождитесь его истечения перед сменой тарифа или способа оплаты.",
        409
      );
    }

    const tariff = TARIF_PRICES[planId];
    const createdMs = clock();
    const invoice = {
      id: `inv_${crypto.randomBytes(24).toString("base64url")}`,
      userId: user.id,
      planId,
      planTitle: tariff.title,
      days: tariff.days,
      baseAmountMinor: tariff.usd * 100,
      method,
      status: "pending",
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(createdMs).toISOString(),
      expiresAt: createdMs + INVOICE_TTL_MS,
      nextVerificationAt: 0
    };

    if (method === "cryptobot") {
      let providerInvoice;
      try {
        providerInvoice = await cryptoPayRequest("createInvoice", {
          currency_type: "crypto",
          asset: "USDT",
          amount: minorToDecimal(invoice.baseAmountMinor),
          description: `Obsidian Screener PRO — ${tariff.title}`,
          hidden_message: "Спасибо за оплату! Подписка активируется автоматически.",
          paid_btn_name: "openBot",
          paid_btn_url: safeString(env.PAYMENT_SUCCESS_URL, 2048) || "https://t.me/ObsidianScreenerBot",
          payload: invoice.id,
          allow_comments: false,
          allow_anonymous: true,
          expires_in: Math.floor(INVOICE_TTL_MS / 1000)
        });
      } catch (error) {
        if (error instanceof PaymentError) throw error;
        throw new PaymentError("PROVIDER_UNAVAILABLE", "Не удалось создать счёт Crypto Pay.", 502);
      }
      const providerId = String(providerInvoice && providerInvoice.invoice_id || "");
      const payUrl = safeString(
        providerInvoice && (
          providerInvoice.bot_invoice_url ||
          providerInvoice.mini_app_invoice_url ||
          providerInvoice.web_app_invoice_url ||
          providerInvoice.pay_url
        ),
        2048
      );
      if (!CRYPTO_PAY_INVOICE_ID_REGEX.test(providerId) || !/^https:\/\//i.test(payUrl)) {
        throw new PaymentError("INVALID_PROVIDER_RESPONSE", "Crypto Pay вернул некорректный счёт.", 502);
      }
      invoice.cryptoPayInvoiceId = providerId;
      invoice.amountMinor = invoice.baseAmountMinor;
      invoice.amountStr = minorToDecimal(invoice.amountMinor);
      invoice.payUrl = payUrl;
    } else {
      const allocation = allocateFloatingCents("trc20", tariff.usd);
      invoice.amountMinor = allocation.amountMinor;
      invoice.amountStr = allocation.amountStr;
      invoice.reservationKey = allocation.key;
      invoice.address = wallets.trc20;
      invoice.qrData = `tron:${wallets.trc20}?amount=${allocation.amountStr}&token=USDT`;
      amountReservations.set(allocation.key, invoice.id);
    }

    invoices.set(invoice.id, invoice);
    userActiveInvoices.set(user.id, invoice.id);
    try {
      persistInvoices();
    } catch (error) {
      invoices.delete(invoice.id);
      releaseInvoiceReservation(invoice);
      throw new PaymentError("PERSISTENCE_FAILURE", "Не удалось надёжно сохранить счёт.", 503);
    }
    return presentInvoice(invoice);
  }

  function findPaymentByInvoice(invoiceId) {
    return payments.find(payment => payment && payment.invoiceId === invoiceId && payment.status === "success");
  }

  async function verifyTronInvoice(invoice) {
    const query = new URLSearchParams({
      limit: "50",
      contract_address: TRC20_USDT_CONTRACT,
      only_confirmed: "true",
      order_by: "block_timestamp,desc",
      min_timestamp: String(Math.max(0, Date.parse(invoice.createdAt))),
      max_timestamp: String(invoice.expiresAt + PAYMENT_GRACE_MS)
    });
    const headers = { "Accept": "application/json" };
    if (tronGridApiKey) headers["TRON-PRO-API-KEY"] = tronGridApiKey;
    const url = `https://api.trongrid.io/v1/accounts/${encodeURIComponent(invoice.address)}/transactions/trc20?${query}`;
    let response;
    try {
      response = await fetchJson(url, { headers });
    } catch (_) {
      throw new PaymentError("PROVIDER_UNAVAILABLE", "Проверка сети TRON временно недоступна.", 502);
    }
    if (!response || !Array.isArray(response.data)) return false;

    const expectedRaw = BigInt(invoice.amountMinor) * 10_000n;
    const createdMs = Date.parse(invoice.createdAt);
    for (const transaction of response.data) {
      if (!transaction || transaction.to !== invoice.address) continue;
      if (transaction.type !== "Transfer") continue;
      const tokenInfo = transaction.token_info;
      if (!tokenInfo || tokenInfo.address !== TRC20_USDT_CONTRACT) continue;
      if (String(tokenInfo.symbol || "").toUpperCase() !== "USDT") continue;
      if (Number(tokenInfo.decimals) !== 6) continue;
      const transactionId = safeString(transaction.transaction_id, 128);
      if (!/^[a-fA-F0-9]{64}$/.test(transactionId)) continue;
      const timestamp = Number(transaction.block_timestamp);
      if (!Number.isFinite(timestamp) || timestamp < createdMs) continue;
      if (timestamp > invoice.expiresAt + PAYMENT_GRACE_MS) continue;
      if (typeof transaction.value !== "string" || !/^\d+$/.test(transaction.value)) continue;
      if (BigInt(transaction.value) !== expectedRaw) continue;
      await completeSuccessfulPayment(invoice, {
        txId: transactionId.toLowerCase(),
        amountMinor: invoice.amountMinor,
        currency: "USDT TRC-20",
        method: "trc20",
        provider: "trongrid",
        confirmedAt: new Date(timestamp).toISOString()
      });
      return true;
    }
    return false;
  }

  function validateCryptoPayInvoice(providerInvoice, invoice) {
    if (!providerInvoice || String(providerInvoice.invoice_id || "") !== invoice.cryptoPayInvoiceId) return false;
    if (providerInvoice.status !== "paid") return false;
    if (providerInvoice.payload !== invoice.id) return false;
    if (String(providerInvoice.asset || "").toUpperCase() !== "USDT") return false;
    if (decimalToMinor(providerInvoice.amount) !== invoice.baseAmountMinor) return false;
    return true;
  }

  async function fetchCryptoPayInvoice(invoice) {
    const result = await cryptoPayRequest("getInvoices", {
      invoice_ids: invoice.cryptoPayInvoiceId
    });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find(item => String(item && item.invoice_id || "") === invoice.cryptoPayInvoiceId) || null;
  }

  async function verifyCryptoPayInvoice(invoice) {
    let providerInvoice;
    try {
      providerInvoice = await fetchCryptoPayInvoice(invoice);
    } catch (error) {
      if (error instanceof PaymentError) throw error;
      throw new PaymentError("PROVIDER_UNAVAILABLE", "Crypto Pay временно недоступен.", 502);
    }
    if (!providerInvoice) return false;
    if (providerInvoice.status === "expired") {
      invoice.status = "expired";
      invoice.updatedAt = new Date(clock()).toISOString();
      releaseInvoiceReservation(invoice);
      persistInvoices();
      return false;
    }
    if (!validateCryptoPayInvoice(providerInvoice, invoice)) return false;
    await completeSuccessfulPayment(invoice, {
      txId: `cryptopay:${invoice.cryptoPayInvoiceId}`,
      amountMinor: invoice.baseAmountMinor,
      currency: "USDT",
      method: "cryptobot",
      provider: cryptoPayTestnet ? "crypto-pay-testnet" : "crypto-pay",
      confirmedAt: safeString(providerInvoice.paid_at, 128) || new Date(clock()).toISOString()
    });
    return true;
  }

  async function verifyInvoice(invoice, force = false) {
    const existingPromise = verificationPromises.get(invoice.id);
    if (existingPromise) return existingPromise;
    if (!force && Number(invoice.nextVerificationAt) > clock()) return false;
    invoice.nextVerificationAt = clock() + STATUS_CHECK_INTERVAL_MS;
    const promise = (async () => {
      try {
        let verified = false;
        if (invoice.method === "trc20") verified = await verifyTronInvoice(invoice);
        else if (invoice.method === "cryptobot") verified = await verifyCryptoPayInvoice(invoice);
        if (!verified && clock() >= invoice.expiresAt + PAYMENT_GRACE_MS) {
          invoice.finalVerificationAt = clock();
          invoice.updatedAt = new Date(clock()).toISOString();
          persistInvoices();
        }
        return verified;
      } finally {
        verificationPromises.delete(invoice.id);
      }
    })();
    verificationPromises.set(invoice.id, promise);
    return promise;
  }

  async function getInvoiceStatus(invoiceId, userId) {
    if (!INVOICE_ID_REGEX.test(String(invoiceId || ""))) {
      throw new PaymentError("INVOICE_NOT_FOUND", "Счёт не найден.", 404);
    }
    const invoice = invoices.get(invoiceId);
    if (!invoice) {
      const payment = findPaymentByInvoice(invoiceId);
      if (payment && payment.userId === userId) return { status: "success" };
      throw new PaymentError("INVOICE_NOT_FOUND", "Счёт не найден.", 404);
    }
    if (invoice.userId !== userId) {
      throw new PaymentError("INVOICE_NOT_FOUND", "Счёт не найден.", 404);
    }
    if (["pending", "processing"].includes(invoice.status)) {
      const requiresFinalCheck = clock() >= invoice.expiresAt + PAYMENT_GRACE_MS;
      try { await verifyInvoice(invoice, requiresFinalCheck); } catch (error) {
        if (!(error instanceof PaymentError) || error.code !== "PROVIDER_UNAVAILABLE") throw error;
      }
      cleanupExpiredInvoices();
    }
    return { status: invoice.status, invoice: presentInvoice(invoice) };
  }

  async function reconcileExpiredInvoices() {
    const candidates = Array.from(invoices.values()).filter(invoice => (
      ["pending", "processing"].includes(invoice.status) &&
      Number.isFinite(invoice.expiresAt) &&
      invoice.expiresAt + PAYMENT_GRACE_MS <= clock()
    ));
    for (const invoice of candidates) {
      try {
        await verifyInvoice(invoice, true);
      } catch (error) {
        // A provider outage must never turn an unverified invoice into expired.
        if (!(error instanceof PaymentError) || error.code !== "PROVIDER_UNAVAILABLE") throw error;
      }
    }
    cleanupExpiredInvoices();
  }

  async function completeSuccessfulPayment(invoice, evidence) {
    if (!invoice || !evidence) throw new Error("Payment completion requires verified evidence");
    const txId = safeString(evidence.txId, 160);
    if (!txId) throw new Error("Verified payment must have a transaction identifier");
    const lockKeys = [invoice.id, txId];
    if (lockKeys.some(key => processingLocks.has(key))) return findPaymentByInvoice(invoice.id) || null;
    lockKeys.forEach(key => processingLocks.add(key));
    try {
      const existingByInvoice = findPaymentByInvoice(invoice.id);
      if (existingByInvoice) {
        invoice.status = "success";
        invoice.txId = existingByInvoice.txId;
        invoice.updatedAt = new Date(clock()).toISOString();
        releaseInvoiceReservation(invoice);
        persistInvoices();
        return existingByInvoice;
      }
      const existingByTx = payments.find(payment => payment && payment.txId === txId);
      if (existingByTx) {
        if (existingByTx.invoiceId !== invoice.id) throw new Error("Transaction is already assigned to another invoice");
        invoice.status = "success";
        invoice.txId = existingByTx.txId;
        invoice.updatedAt = new Date(clock()).toISOString();
        releaseInvoiceReservation(invoice);
        persistInvoices();
        return existingByTx;
      }
      if (processedTransactionIds.has(txId)) throw new Error("Transaction was already processed");
      if (!["pending", "processing"].includes(invoice.status)) return null;
      if (evidence.method !== invoice.method) throw new Error("Payment method mismatch");
      if (evidence.amountMinor !== invoice.amountMinor) throw new Error("Payment amount mismatch");
      if (typeof gatewayUserStore.grantPlanForPayment !== "function") {
        throw new Error("Idempotent subscription grant is not configured");
      }

      invoice.status = "processing";
      invoice.updatedAt = new Date(clock()).toISOString();
      persistInvoices();

      const grantResult = gatewayUserStore.grantPlanForPayment(
        invoice.userId,
        `invoice:${invoice.id}`,
        invoice.days
      );
      if (!grantResult || !grantResult.user) throw new Error("Subscription grant failed");

      const paymentRecord = {
        id: `pay_${crypto.randomBytes(18).toString("base64url")}`,
        invoiceId: invoice.id,
        userId: invoice.userId,
        username: grantResult.user.username || invoice.userId,
        amount: Number((evidence.amountMinor / 100).toFixed(2)),
        amountMinor: evidence.amountMinor,
        currency: evidence.currency,
        method: evidence.method,
        provider: evidence.provider,
        status: "success",
        txId,
        days: invoice.days,
        planTitle: invoice.planTitle,
        confirmedAt: evidence.confirmedAt,
        date: new Date(clock()).toISOString()
      };
      payments.unshift(paymentRecord);
      persistPayments();
      processedTransactionIds.add(txId);

      invoice.status = "success";
      invoice.txId = txId;
      invoice.updatedAt = new Date(clock()).toISOString();
      releaseInvoiceReservation(invoice);
      persistInvoices();

      if (typeof options.notifyPayment === "function") {
        try { await options.notifyPayment(paymentRecord, grantResult.user); } catch (_) {}
      } else if (options.notifyPayment !== false) {
        try {
          const adminBot = require("./adminBot");
          const escapedUsername = String(grantResult.user.username || "—")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          await adminBot.sendAdminMessage(
            `<b>💳 ПЛАТЁЖ ПОДТВЕРЖДЁН</b>\n\n` +
            `<b>Пользователь:</b> #${invoice.userId} (${escapedUsername})\n` +
            `<b>Сумма:</b> $${minorToDecimal(evidence.amountMinor)} ${evidence.currency}\n` +
            `<b>Метод:</b> ${evidence.method}\n` +
            `<b>Тариф:</b> ${invoice.planTitle}\n` +
            `<b>TxID:</b> <code>${txId.slice(0, 24)}...</code>`
          );
        } catch (_) {}
      }
      return paymentRecord;
    } finally {
      lockKeys.forEach(key => processingLocks.delete(key));
    }
  }

  function verifyCryptoBotWebhook(rawBody, headerSignature) {
    if (!cryptoPayToken || !rawBody) return false;
    const signature = safeString(headerSignature, 256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(signature)) return false;
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
    const secret = crypto.createHash("sha256").update(cryptoPayToken).digest();
    const expected = crypto.createHmac("sha256", secret).update(bodyBuffer).digest("hex");
    return constantTimeEqual(expected, signature);
  }

  function verifyWebhookPathSecret(candidate) {
    return webhookPathSecret.length >= 32 && constantTimeEqual(webhookPathSecret, String(candidate || ""));
  }

  async function handleCryptoBotWebhook(rawBody, headerSignature) {
    if (!verifyCryptoBotWebhook(rawBody, headerSignature)) {
      throw new PaymentError("INVALID_WEBHOOK_SIGNATURE", "Invalid webhook signature.", 401);
    }
    let update;
    try {
      update = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    } catch (_) {
      throw new PaymentError("INVALID_WEBHOOK", "Invalid webhook body.", 400);
    }
    if (!update || typeof update !== "object") {
      throw new PaymentError("INVALID_WEBHOOK", "Invalid webhook body.", 400);
    }
    const requestTime = Date.parse(update.request_date || "");
    const age = clock() - requestTime;
    if (!Number.isFinite(requestTime) || age < -60_000 || age > MAX_WEBHOOK_AGE_MS) {
      throw new PaymentError("STALE_WEBHOOK", "Stale webhook.", 400);
    }
    if (update.update_type !== "invoice_paid") return { accepted: true, processed: false };
    const providerId = String(update.payload && update.payload.invoice_id || "");
    if (!CRYPTO_PAY_INVOICE_ID_REGEX.test(providerId)) {
      throw new PaymentError("INVALID_WEBHOOK", "Invalid provider invoice.", 400);
    }
    const invoice = Array.from(invoices.values()).find(candidate => (
      candidate.method === "cryptobot" && candidate.cryptoPayInvoiceId === providerId
    ));
    if (!invoice) return { accepted: true, processed: false };
    const paid = await verifyInvoice(invoice, true);
    return { accepted: true, processed: Boolean(paid || invoice.status === "success") };
  }

  function getUserPayments(userId) {
    return payments.filter(payment => payment && payment.userId === userId).map(payment => ({ ...payment }));
  }

  function getAllPayments() {
    return payments.map(payment => ({ ...payment }));
  }

  function setMasterTronAddress(address) {
    const cleanAddress = safeString(address, 128);
    if (!TRON_ADDRESS_REGEX.test(cleanAddress)) return false;
    wallets.trc20 = cleanAddress;
    return true;
  }

  function getOfficialWallets() {
    return Object.freeze({ trc20: wallets.trc20 || null });
  }

  return {
    TARIF_PRICES,
    PaymentError,
    createInvoice,
    getInvoiceStatus,
    handleCryptoBotWebhook,
    verifyCryptoBotWebhook,
    verifyWebhookPathSecret,
    getUserPayments,
    getAllPayments,
    setMasterTronAddress,
    getOfficialWallets,
    getPublicConfig,
    getAvailableMethods,
    _test: {
      decimalToMinor,
      minorToDecimal,
      presentInvoice,
      cleanupExpiredInvoices,
      reconcileExpiredInvoices,
      getInvoice: invoiceId => invoices.get(invoiceId)
    }
  };
}

const defaultGateway = createPaymentGateway();

module.exports = {
  ...defaultGateway,
  createPaymentGateway,
  PaymentError,
  TARIF_PRICES
};
