"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SUPPORTED_EXCHANGES = new Set(["BN", "BB", "OX"]);

function canonicalExchange(value) {
  const text = String(value || "").trim().toUpperCase();
  if (text === "BINANCE") return "BN";
  if (text === "BYBIT") return "BB";
  if (text === "OKX") return "OX";
  return SUPPORTED_EXCHANGES.has(text) ? text : "";
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
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

function loadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { version: 1, users: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && parsed.version === 1 && parsed.users ? parsed : { version: 1, users: {} };
  } catch (error) {
    console.error("[journal-credentials] load failed:", error.message);
    return { version: 1, users: {} };
  }
}

function createJournalCredentialStore(options = {}) {
  const filePath = options.filePath || path.join(__dirname, "journal_credentials.json");
  const rootSecret = String(options.secret || process.env.JOURNAL_KEYS_ENCRYPTION_KEY || process.env.ADMIN_API_SECRET || "");
  if (rootSecret.length < 32) throw new Error("Journal credential encryption secret must contain at least 32 characters");
  const key = crypto.createHash("sha256").update(`obsidian-journal-credentials-v1\0${rootSecret}`).digest();
  let data = loadFile(filePath);

  function encrypt(userId, exchange, credentials) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${exchange}:v1`));
    const body = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), body: body.toString("base64"), updatedAt: Date.now() };
  }

  function decrypt(userId, exchange, record) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(`${userId}:${exchange}:v1`));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.body, "base64")), decipher.final()]).toString("utf8"));
  }

  function save(userId, exchangeInput, credentials) {
    const exchange = canonicalExchange(exchangeInput);
    if (!userId || !exchange) throw new Error("Unsupported journal exchange");
    const clean = {
      apiKey: String(credentials.apiKey || "").trim(),
      apiSecret: String(credentials.apiSecret || "").trim(),
      passphrase: String(credentials.passphrase || "").trim(),
    };
    if (!clean.apiKey || !clean.apiSecret || clean.apiKey.length > 256 || clean.apiSecret.length > 256 || clean.passphrase.length > 256) throw new Error("Invalid API credentials");
    if (!data.users[userId]) data.users[userId] = {};
    data.users[userId][exchange] = encrypt(userId, exchange, clean);
    atomicWrite(filePath, data);
    return { exchange, configured: true, updatedAt: data.users[userId][exchange].updatedAt };
  }

  function get(userId, exchangeInput) {
    const exchange = canonicalExchange(exchangeInput);
    const record = exchange && data.users[userId]?.[exchange];
    if (!record) return null;
    try { return decrypt(userId, exchange, record); }
    catch (error) {
      console.error(`[journal-credentials] decrypt failed for ${userId}/${exchange}:`, error.message);
      return null;
    }
  }

  function list(userId) {
    return Object.entries(data.users[userId] || {}).map(([exchange, record]) => ({ exchange, configured: Boolean(get(userId, exchange)), updatedAt: Number(record.updatedAt) || 0 })).filter(item => item.configured);
  }

  function remove(userId, exchangeInput) {
    const exchange = canonicalExchange(exchangeInput);
    if (!exchange || !data.users[userId]?.[exchange]) return false;
    delete data.users[userId][exchange];
    if (!Object.keys(data.users[userId]).length) delete data.users[userId];
    atomicWrite(filePath, data);
    return true;
  }

  return { canonicalExchange, save, get, list, remove };
}

module.exports = { createJournalCredentialStore, canonicalExchange };
