"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const excelExporter = require("./excelExporter");

const USERS_FILE = path.join(__dirname, "users.json");
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const LOGS_FILE = path.join(__dirname, "auth_logs.json");

const PASSWORD_ALGORITHM = "scrypt-v1";
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365-day (1 year) persistent session TTL

// Atomic, crash-resistant file write. Callers can fail closed on false.
function saveJSON(filePath, data) {
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
    if (filePath === USERS_FILE) {
      setImmediate(() => {
        try { excelExporter.generateUsersExcel(data); } catch (_) {}
      });
    }
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    console.error(`[userStore] Error saving ${filePath}:`, err.message);
    return false;
  }
}

function loadJSON(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[userStore] Error loading ${filePath}:`, err.message);
  }
  return fallback;
}

// In-memory cache loaded from disk
let users = loadJSON(USERS_FILE, {}); // userId -> userObject
let sessions = loadJSON(SESSIONS_FILE, {}); // token -> { userId, createdAt }
let authLogs = loadJSON(LOGS_FILE, []); // Array of log objects

// Migrate legacy plaintext session-token keys to SHA-256 keys and attach a
// finite lifetime. This keeps a leaked sessions file from being directly usable.
(function migrateLegacySessions() {
  const now = Date.now();
  let changed = false;
  for (const [key, session] of Object.entries(sessions)) {
    if (!session || typeof session !== "object") {
      delete sessions[key];
      changed = true;
      continue;
    }
    const createdAt = Date.parse(session.createdAt || "");
    const expiresAt = Number(session.expiresAt) || (createdAt + SESSION_TTL_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      delete sessions[key];
      changed = true;
      continue;
    }
    if (!Number.isFinite(Number(session.expiresAt))) {
      const hashedKey = crypto.createHash("sha256").update(key).digest("hex");
      delete sessions[key];
      sessions[hashedKey] = { ...session, expiresAt };
      changed = true;
    }
  }
  if (changed) saveJSON(SESSIONS_FILE, sessions);
})();

function logAuthEvent(eventData) {
  const logEntry = {
    id: crypto.randomBytes(8).toString("hex"),
    timestamp: new Date().toISOString(),
    ...eventData
  };
  authLogs.unshift(logEntry); // new logs at top
  if (authLogs.length > 5000) authLogs = authLogs.slice(0, 5000); // keep last 5000 logs
  saveJSON(LOGS_FILE, authLogs);
}

// Generate unique 6-digit User ID (format: USR-849201)
function generateUserId() {
  let id;
  do {
    const num = Math.floor(100000 + Math.random() * 900000);
    id = `USR-${num}`;
  } while (users[id]);
  return id;
}

// Memory-hard password hashing for new passwords. Legacy PBKDF2 hashes are
// verified once and transparently upgraded after a successful login.
function hashPassword(password, salt) {
  const passwordText = String(password);
  const saltBuffer = salt ? Buffer.from(salt, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(passwordText, saltBuffer, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
  }).toString("hex");
  return { hash, salt: saltBuffer.toString("hex"), algorithm: PASSWORD_ALGORITHM };
}

function timingSafeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!/^[a-fA-F0-9]+$/.test(left) || !/^[a-fA-F0-9]+$/.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  if (user.passwordAlgorithm === PASSWORD_ALGORITHM) {
    const { hash } = hashPassword(password, user.salt);
    return timingSafeHexEqual(hash, user.passwordHash);
  }
  const legacyHash = crypto.pbkdf2Sync(String(password), user.salt, 10000, 64, "sha512").toString("hex");
  return timingSafeHexEqual(legacyHash, user.passwordHash);
}

function cleanPassword(password) {
  return String(password == null ? "" : password);
}

// Create session token
function createSession(userId) {
  const now = Date.now();
  for (const [key, session] of Object.entries(sessions)) {
    const expiresAt = Number(session && session.expiresAt) || (Date.parse(session && session.createdAt || "") + SESSION_TTL_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) delete sessions[key];
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  sessions[tokenHash] = {
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + SESSION_TTL_MS
  };
  saveJSON(SESSIONS_FILE, sessions);
  return token;
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, salt, passwordAlgorithm, appliedPaymentIds, ...safe } = user;
  if (!safe.plan) safe.plan = "free";
  if (safe.plan === "pro") {
    if (!user.proExpiresAt) {
      safe.proDaysLeft = "∞";
    } else {
      const diff = Math.max(0, Math.ceil((user.proExpiresAt - Date.now()) / (1000 * 60 * 60 * 24)));
      if (diff >= 8000) {
        safe.proDaysLeft = "∞";
      } else {
        safe.proDaysLeft = diff;
      }
    }
  } else {
    safe.proDaysLeft = null;
  }
  safe.notifications = Array.isArray(user.notifications) ? user.notifications : [];
  return safe;
}

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com",
  "trashmail.com", "yopmail.com", "dispostable.com", "getnada.com",
  "sharklasers.com", "throwawaymail.com", "fake.com", "test.com",
  "example.com", "asdf.com", "qwerty.com", "temp-mail.org", "fakeinbox.com",
  "maildrop.cc", "getairmail.com", "mohmal.com", "crazymailing.com"
]);

const FAKE_TLDS = new Set([
  "test", "example", "invalid", "localhost", "local", "sdfg", "asdf", "qwerty"
]);

function validateEmail(email) {
  if (!email || typeof email !== "string") {
    return { valid: false, error: "Укажите Email адрес" };
  }

  const clean = email.trim().toLowerCase();

  if (clean.length > 254) {
    return { valid: false, error: "Email слишком длинный" };
  }

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(clean)) {
    return { valid: false, error: "Введите корректный Email адрес (например: name@domain.com)" };
  }

  if (clean.includes("..") || clean.startsWith(".") || clean.includes("@.")) {
    return { valid: false, error: "Некорректный формат Email адреса" };
  }

  const parts = clean.split("@");
  if (parts.length !== 2) {
    return { valid: false, error: "Email должен содержать ровно один символ '@'" };
  }

  const [localPart, domain] = parts;
  if (localPart.length < 1 || domain.length < 3) {
    return { valid: false, error: "Слишком короткое имя или домен Email" };
  }

  const domainParts = domain.split(".");
  const tld = domainParts[domainParts.length - 1];

  if (FAKE_TLDS.has(tld) || tld.length < 2) {
    return { valid: false, error: "Укажите существующий домен электронной почты (например, gmail.com, yandex.ru, mail.ru)" };
  }

  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return { valid: false, error: "Регистрация с временных или одноразовых Email адресов запрещена" };
  }

  return { valid: true };
}

function validatePassword(password) {
  if (!password || typeof password !== "string") {
    return { valid: false, error: "Укажите пароль" };
  }

  if (/[а-яА-ЯЁё]/i.test(password)) {
    return { valid: false, error: "Пароль должен быть на английском языке (без кириллицы)" };
  }

  if (/\s/.test(password)) {
    return { valid: false, error: "Пароль не должен содержать пробелы" };
  }

  if (password.length < 8 || password.length > 128) {
    return { valid: false, error: "Пароль должен быть длиной от 8 до 128 символов" };
  }

  if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{}|;:,.<>?/~'"]+$/.test(password)) {
    return { valid: false, error: "Пароль содержит недопустимые символы. Используйте только английские буквы, цифры и спецсимволы" };
  }

  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, error: "Пароль должен содержать хотя бы одну английскую букву" };
  }

  if (!/[0-9!@#$%^&*()_+\-=\[\]{}|;:,.<>?/~'"]/.test(password)) {
    return { valid: false, error: "Пароль должен содержать хотя бы одну цифру или спецсимвол" };
  }

  return { valid: true };
}

// Register user with email/username & password
function registerUser({ username, email, password, ip = "" }) {
  if (!username || !email || !password) {
    throw new Error("Заполните все обязательные поля");
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanUsername = String(username).trim();
  const passwordText = cleanPassword(password);

  if (cleanUsername.length < 2 || cleanUsername.length > 64) throw new Error("Некорректное имя пользователя");

  const passCheck = validatePassword(passwordText);
  if (!passCheck.valid) {
    throw new Error(passCheck.error);
  }
  
  const emailCheck = validateEmail(cleanEmail);
  if (!emailCheck.valid) {
    throw new Error(emailCheck.error);
  }

  // Check uniqueness
  for (const u of Object.values(users)) {
    if (u.email && u.email.toLowerCase() === cleanEmail) {
      throw new Error("Пользователь с таким Email уже зарегистрирован");
    }
  }

  const userId = generateUserId();
  const { hash, salt, algorithm } = hashPassword(passwordText);

  const newUser = {
    id: userId,
    username: cleanUsername,
    email: cleanEmail,
    passwordHash: hash,
    salt,
    passwordAlgorithm: algorithm,
    authMethod: "login",
    role: "PRO Trader",
    plan: "free",
    createdAt: new Date().toISOString(),
    avatar: ""
  };

  users[userId] = newUser;
  saveJSON(USERS_FILE, users);

  logAuthEvent({
    event: "REGISTER",
    userId,
    username: cleanUsername,
    email: cleanEmail,
    authMethod: "login",
    ip
  });

  try {
    const telegramBot = require("./telegramBot");
    telegramBot.sendAdminNotification(newUser, { authMethod: "Логин / Пароль", ip });
  } catch (_) {}

  const token = createSession(userId);
  return { token, user: sanitizeUser(newUser), isNew: true };
}

// Login user
function loginUser({ emailOrUsername, password, ip = "" }) {
  if (!emailOrUsername || !password) {
    throw new Error("Укажите логин/email и пароль");
  }

  const query = emailOrUsername.trim().toLowerCase();
  let foundUser = null;

  for (const u of Object.values(users)) {
    if (
      (u.email && u.email.toLowerCase() === query) ||
      (u.username && u.username.toLowerCase() === query)
    ) {
      foundUser = u;
      break;
    }
  }

  if (!foundUser || !foundUser.passwordHash) {
    logAuthEvent({ event: "LOGIN_FAILED", query, ip, reason: "User not found" });
    throw new Error("Неверный логин или пароль");
  }

  if (foundUser.blocked) {
    throw new Error(`Аккаунт заблокирован: ${foundUser.blockReason || "Нарушение правил"}`);
  }

  const passwordText = cleanPassword(password);
  if (passwordText.length > 1024) throw new Error("Неверный логин или пароль");
  const isValid = verifyPassword(passwordText, foundUser);
  if (!isValid) {
    logAuthEvent({ event: "LOGIN_FAILED", userId: foundUser.id, query, ip, reason: "Invalid password" });
    throw new Error("Неверный логин или пароль");
  }

  if (foundUser.passwordAlgorithm !== PASSWORD_ALGORITHM) {
    const upgraded = hashPassword(passwordText);
    foundUser.passwordHash = upgraded.hash;
    foundUser.salt = upgraded.salt;
    foundUser.passwordAlgorithm = upgraded.algorithm;
    saveJSON(USERS_FILE, users);
  }

  logAuthEvent({ event: "LOGIN_SUCCESS", userId: foundUser.id, username: foundUser.username, ip });

  const token = createSession(foundUser.id);
  return { token, user: sanitizeUser(foundUser) };
}

// Telegram Authorization (Register / Login)
function telegramAuth(tgData, chatId = null, ip = "") {
  if (!tgData || !tgData.id) {
    throw new Error("Некорректные данные авторизации Telegram");
  }

  const tgId = String(tgData.id);
  let foundUser = null;

  for (const u of Object.values(users)) {
    if (u.telegramId === tgId) {
      foundUser = u;
      break;
    }
  }

  if (foundUser && foundUser.blocked) {
    throw new Error(`Аккаунт заблокирован: ${foundUser.blockReason || "Нарушение правил"}`);
  }

  let isNew = false;
  let modified = false;

  if (!foundUser) {
    isNew = true;
    const userId = generateUserId();
    const username = tgData.username
      ? `@${tgData.username}`
      : [tgData.first_name, tgData.last_name].filter(Boolean).join(" ") || `Telegram #${tgId.slice(-4)}`;

    foundUser = {
      id: userId,
      username,
      email: `${tgId}@telegram.user`,
      telegramId: tgId,
      telegramChatId: chatId ? String(chatId) : String(tgId),
      telegramLinked: true,
      photoUrl: tgData.photo_url || "",
      authMethod: "telegram",
      role: "VIP Trader",
      plan: "free",
      createdAt: new Date().toISOString(),
      avatar: tgData.photo_url || ""
    };

    users[userId] = foundUser;
    modified = true;

    logAuthEvent({
      event: "REGISTER_TELEGRAM",
      userId,
      username,
      telegramId: tgId,
      chatId: String(chatId || tgId),
      ip
    });
  } else {
    if (chatId && foundUser.telegramChatId !== String(chatId)) {
      foundUser.telegramChatId = String(chatId);
      foundUser.telegramLinked = true;
      modified = true;
    }
    if (tgData.photo_url && foundUser.avatar !== tgData.photo_url) {
      foundUser.avatar = tgData.photo_url;
      modified = true;
    }

    logAuthEvent({
      event: "LOGIN_TELEGRAM",
      userId: foundUser.id,
      username: foundUser.username,
      telegramId: tgId,
      ip
    });
  }

  if (modified) saveJSON(USERS_FILE, users);

  const token = createSession(foundUser.id);
  return { token, user: sanitizeUser(foundUser), isNew };
}

// Validate session token with 365-day sliding renewal
function getUserByToken(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  let sessionKey = tokenHash;
  let session = sessions[tokenHash];
  if (!session && sessions[token]) {
    // One-time migration for sessions created by older builds.
    session = sessions[token];
    delete sessions[token];
    sessions[tokenHash] = session;
    sessionKey = tokenHash;
    saveJSON(SESSIONS_FILE, sessions);
  }
  if (!session) return null;
  const now = Date.now();
  const createdAt = Date.parse(session.createdAt || "");
  const expiresAt = Number(session.expiresAt) || (createdAt + SESSION_TTL_MS);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    delete sessions[sessionKey];
    saveJSON(SESSIONS_FILE, sessions);
    return null;
  }

  // Sliding Session Renewal: Automatically renew 365 days every 6 hours of user activity
  if (now - (session.lastRenewedAt || 0) > 6 * 60 * 60 * 1000) {
    session.expiresAt = now + SESSION_TTL_MS;
    session.lastRenewedAt = now;
    saveJSON(SESSIONS_FILE, sessions);
  }

  const user = users[session.userId];
  if (!user) return null;
  if (user.blocked && (!user.blockExpiresAt || user.blockExpiresAt > now)) return null;
  return sanitizeUser(user);
}

// Update profile name
function updateProfile(userId, { username }) {
  if (!userId || !users[userId]) {
    throw new Error("Пользователь не найден");
  }
  if (!username || !username.trim()) {
    throw new Error("Имя пользователя не может быть пустым");
  }

  users[userId].username = username.trim();
  saveJSON(USERS_FILE, users);

  logAuthEvent({ event: "UPDATE_PROFILE", userId, newUsername: username.trim() });

  return sanitizeUser(users[userId]);
}

// Link Telegram Bot chatId to User Account
function linkTelegramBot(userId, chatId, tgUsername) {
  if (!userId || !users[userId]) return false;
  users[userId].telegramChatId = String(chatId);
  users[userId].telegramLinked = true;
  users[userId].tgAlertsEnabled = true;
  if (tgUsername) users[userId].telegramUsername = tgUsername;
  saveJSON(USERS_FILE, users);

  logAuthEvent({ event: "LINK_TELEGRAM_BOT", userId, chatId: String(chatId), tgUsername });
  return true;
}

function setTelegramAlertsEnabledByChatId(chatId, enabled) {
  if (!chatId) return false;
  const strId = String(chatId);
  for (const u of Object.values(users)) {
    if (u.telegramChatId === strId || u.telegramId === strId) {
      u.tgAlertsEnabled = !!enabled;
      saveJSON(USERS_FILE, users);
      return true;
    }
  }
  return false;
}

function isTelegramAlertsEnabled(chatId) {
  if (!chatId) return true;
  const strId = String(chatId);
  for (const u of Object.values(users)) {
    if (u.telegramChatId === strId || u.telegramId === strId) {
      return u.tgAlertsEnabled !== false;
    }
  }
  return true;
}

function getUserByTelegramId(tgId) {
  if (!tgId) return null;
  const strId = String(tgId);
  for (const u of Object.values(users)) {
    if (u.telegramId === strId || u.telegramChatId === strId) {
      return sanitizeUser(u);
    }
  }
  return null;
}

function getUserStats() {
  const all = Object.values(users);
  const total = all.length;
  const proCount = all.filter(u => u.plan === "pro").length;
  const freeCount = total - proCount;
  const telegramCount = all.filter(u => u.authMethod === "telegram" || u.telegramId).length;
  const loginCount = total - telegramCount;
  const activeSessions = Object.keys(sessions).length;
  
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const registered24h = all.filter(u => new Date(u.createdAt).getTime() >= dayAgo).length;

  const recentUsers = [...all]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);

  return {
    total,
    proCount,
    freeCount,
    telegramCount,
    loginCount,
    activeSessions,
    registered24h,
    recentUsers: recentUsers.map(u => ({
      id: u.id,
      username: u.username || "Трейдер",
      method: u.authMethod === "telegram" ? "Telegram" : "Логин/Пароль",
      date: u.createdAt
    }))
  };
}

function setUserPlan(userIdOrTgId, planName, days = 30) {
  const cleanPlan = String(planName || "").toLowerCase() === "pro" ? "pro" : "free";
  let target = users[userIdOrTgId];
  if (!target) {
    const query = String(userIdOrTgId).trim().toUpperCase();
    for (const u of Object.values(users)) {
      if (u.id.toUpperCase() === query || u.telegramId === query || (u.email && u.email.toUpperCase() === query)) {
        target = u;
        break;
      }
    }
  }
  if (!target) return null;
  target.plan = cleanPlan;
  if (cleanPlan === "pro") {
    const validDays = Number.isInteger(+days) && +days > 0 ? +days : 30;
    if (validDays >= 8000) {
      delete target.proExpiresAt;
    } else {
      const currentExpiry = (target.proExpiresAt && target.proExpiresAt > Date.now())
        ? target.proExpiresAt
        : Date.now();
      target.proExpiresAt = currentExpiry + validDays * 24 * 60 * 60 * 1000;
    }
  } else {
    delete target.proExpiresAt;
  }
  saveJSON(USERS_FILE, users);
  logAuthEvent({ event: "SET_PLAN", userId: target.id, plan: cleanPlan, days });
  return sanitizeUser(target);
}

// Apply a paid entitlement exactly once. The durable idempotency key prevents
// duplicate subscription time when a webhook is retried or the process restarts.
function grantPlanForPayment(userId, paymentKey, days) {
  const target = users[userId];
  const cleanKey = String(paymentKey || "");
  const validDays = Number(days);
  if (!target) return null;
  if (!/^invoice:inv_[A-Za-z0-9_-]{32}$/.test(cleanKey)) throw new Error("Invalid payment idempotency key");
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 9999) throw new Error("Invalid subscription duration");

  if (!Array.isArray(target.appliedPaymentIds)) target.appliedPaymentIds = [];
  if (target.appliedPaymentIds.includes(cleanKey)) {
    return { user: sanitizeUser(target), applied: false };
  }

  const previous = {
    plan: target.plan,
    hadExpiry: Object.prototype.hasOwnProperty.call(target, "proExpiresAt"),
    proExpiresAt: target.proExpiresAt,
    appliedPaymentIds: [...target.appliedPaymentIds]
  };

  target.plan = "pro";
  if (validDays >= 8000 || (previous.plan === "pro" && !previous.hadExpiry)) {
    delete target.proExpiresAt;
  } else {
    const base = Number.isFinite(target.proExpiresAt) && target.proExpiresAt > Date.now()
      ? target.proExpiresAt
      : Date.now();
    target.proExpiresAt = base + validDays * 24 * 60 * 60 * 1000;
  }
  target.appliedPaymentIds.push(cleanKey);

  if (!saveJSON(USERS_FILE, users)) {
    target.plan = previous.plan;
    if (previous.hadExpiry) target.proExpiresAt = previous.proExpiresAt;
    else delete target.proExpiresAt;
    target.appliedPaymentIds = previous.appliedPaymentIds;
    throw new Error("Failed to persist paid entitlement");
  }
  logAuthEvent({ event: "PAYMENT_PLAN_GRANT", userId: target.id, paymentKey: cleanKey, days: validDays });
  return { user: sanitizeUser(target), applied: true };
}

function grantBulkProTime(days = 1, audience = "pro") {
  const validDays = Number.isInteger(+days) && +days > 0 ? +days : 1;
  const msToAdd = validDays * 24 * 60 * 60 * 1000;
  let count = 0;

  for (const user of Object.values(users)) {
    if (audience === "pro" && user.plan !== "pro") continue;
    if (audience === "free" && user.plan === "pro") continue;
    
    user.plan = "pro";
    const currentExpiry = (user.proExpiresAt && user.proExpiresAt > Date.now())
      ? user.proExpiresAt
      : Date.now();
    user.proExpiresAt = currentExpiry + msToAdd;
    count++;
  }

  saveJSON(USERS_FILE, users);
  logAuthEvent({ event: "BULK_PRO_GRANT", days: validDays, count, audience });
  return { days: validDays, count };
}

function subtractProTime(userIdOrTgId, days = 1) {
  let target = findUser(userIdOrTgId);
  if (!target) return null;
  if (target.plan !== "pro") return sanitizeUser(target);

  const validDays = Number.isInteger(+days) && +days > 0 ? +days : 1;
  const msToSub = validDays * 24 * 60 * 60 * 1000;

  if (!target.proExpiresAt) {
    // Lifetime subscription: subtraction is ignored to protect lifetime status
    return sanitizeUser(target);
  }
  target.proExpiresAt = target.proExpiresAt - msToSub;

  if (target.proExpiresAt <= Date.now()) {
    target.plan = "free";
    delete target.proExpiresAt;
  }

  saveJSON(USERS_FILE, users);
  logAuthEvent({ event: "SUBTRACT_PLAN", userId: target.id, days });
  return sanitizeUser(target);
}

function subtractBulkProTime(days = 1, audience = "pro") {
  const validDays = Number.isInteger(+days) && +days > 0 ? +days : 1;
  const msToSub = validDays * 24 * 60 * 60 * 1000;
  let count = 0;

  for (const user of Object.values(users)) {
    if (user.plan !== "pro") continue;

    if (user.proExpiresAt) {
      user.proExpiresAt = user.proExpiresAt - msToSub;
      if (user.proExpiresAt <= Date.now()) {
        user.plan = "free";
        delete user.proExpiresAt;
      }
    } else {
      user.proExpiresAt = Date.now() + (3650 - validDays) * 24 * 60 * 60 * 1000;
    }
    count++;
  }

  saveJSON(USERS_FILE, users);
  logAuthEvent({ event: "BULK_PRO_SUBTRACT", days: validDays, count, audience });
  return { days: validDays, count };
}

function findUser(query) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase().replace(/^@/, "");
  const qUpper = q.toUpperCase();

  // 1. Direct ID match
  if (users[qUpper]) return users[qUpper];
  if (users[q]) return users[q];

  for (const u of Object.values(users)) {
    if (
      (u.id && u.id.toUpperCase() === qUpper) ||
      (u.username && u.username.toLowerCase() === q || u.username === `@${q}`) ||
      (u.telegramId && String(u.telegramId) === q) ||
      (u.email && u.email.toLowerCase() === q) ||
      (u.telegramUsername && u.telegramUsername.toLowerCase() === q)
    ) {
      return u;
    }
  }
  return null;
}

function searchUsers(query) {
  if (!query) return [];
  const q = String(query).trim().toLowerCase().replace(/^@/, "");
  const qUpper = q.toUpperCase();

  const results = [];
  for (const u of Object.values(users)) {
    if (
      (u.id && u.id.toUpperCase().includes(qUpper)) ||
      (u.username && u.username.toLowerCase().includes(q)) ||
      (u.telegramId && String(u.telegramId).includes(q)) ||
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.telegramUsername && u.telegramUsername.toLowerCase().includes(q))
    ) {
      results.push(u);
    }
  }
  return results;
}

function blockUser(userId, { reason = "Нарушение правил", days = null } = {}) {
  const target = users[userId] || findUser(userId);
  if (!target) return null;
  target.blocked = true;
  target.blockReason = reason;
  target.blockedAt = new Date().toISOString();
  if (days && Number.isInteger(+days)) {
    target.blockExpiresAt = Date.now() + (+days) * 24 * 60 * 60 * 1000;
  } else {
    delete target.blockExpiresAt;
  }
  saveJSON(USERS_FILE, users);
  revokeAllUserSessions(target.id);
  logAuthEvent({ event: "BLOCK_USER", userId: target.id, reason, days });
  return sanitizeUser(target);
}

function unblockUser(userId) {
  const target = users[userId] || findUser(userId);
  if (!target) return null;
  target.blocked = false;
  delete target.blockReason;
  delete target.blockedAt;
  delete target.blockExpiresAt;
  saveJSON(USERS_FILE, users);
  logAuthEvent({ event: "UNBLOCK_USER", userId: target.id });
  return sanitizeUser(target);
}

function toggleUserTag(userId, tag) {
  const target = users[userId] || findUser(userId);
  if (!target) return null;
  if (!Array.isArray(target.tags)) target.tags = [];
  const idx = target.tags.indexOf(tag);
  if (idx >= 0) {
    target.tags.splice(idx, 1);
  } else {
    target.tags.push(tag);
  }
  saveJSON(USERS_FILE, users);
  logAuthEvent({ event: "TOGGLE_TAG", userId: target.id, tag, tags: target.tags });
  return sanitizeUser(target);
}

function setUserNotes(userId, notes) {
  const target = users[userId] || findUser(userId);
  if (!target) return null;
  target.notes = String(notes || "").trim();
  saveJSON(USERS_FILE, users);
  return sanitizeUser(target);
}

function revokeAllUserSessions(userId) {
  const target = users[userId] || findUser(userId);
  if (!target) return 0;
  let count = 0;
  for (const [token, sess] of Object.entries(sessions)) {
    if (sess.userId === target.id) {
      delete sessions[token];
      count++;
    }
  }
  if (count > 0) saveJSON(SESSIONS_FILE, sessions);
  logAuthEvent({ event: "REVOKE_SESSIONS", userId: target.id, count });
  return count;
}

function resetUserPassword(userId, newPassword) {
  const target = users[userId] || findUser(userId);
  if (!target) return null;
  const passwordText = cleanPassword(newPassword);
  if (passwordText.length < 10 || passwordText.length > 1024) throw new Error("Некорректная длина пароля");
  const { hash, salt, algorithm } = hashPassword(passwordText);
  target.passwordHash = hash;
  target.salt = salt;
  target.passwordAlgorithm = algorithm;
  saveJSON(USERS_FILE, users);
  revokeAllUserSessions(target.id);
  logAuthEvent({ event: "RESET_PASSWORD", userId: target.id });
  return sanitizeUser(target);
}

function touchUserActivity(userId) {
  if (!userId || !users[userId]) return;
  users[userId].lastActive = new Date().toISOString();
}

function getAllUsersRaw() {
  return users;
}

function getAuditLogs() {
  return authLogs;
}

function exportUsersExcel() {
  return excelExporter.generateUsersExcel(users);
}

function addNotificationToUser(userIdOrQuery, notif) {
  let target = findUser(userIdOrQuery);
  if (!target) return null;
  if (!Array.isArray(target.notifications)) target.notifications = [];
  
  const notifObj = {
    id: "notif_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    type: notif.type || "info",
    title: notif.title || "Уведомление",
    message: notif.message || "",
    days: notif.days || 0,
    read: false,
    createdAt: notif.createdAt || new Date().toISOString()
  };

  target.notifications.unshift(notifObj);
  if (target.notifications.length > 50) {
    target.notifications = target.notifications.slice(0, 50);
  }
  saveJSON(USERS_FILE, users);
  return notifObj;
}

function markNotificationRead(userIdOrQuery, notifId) {
  let target = findUser(userIdOrQuery);
  if (!target || !Array.isArray(target.notifications)) return false;
  
  const notif = target.notifications.find(n => n.id === notifId);
  if (notif) {
    notif.read = true;
    saveJSON(USERS_FILE, users);
    return true;
  }
  return false;
}

function getUserPreferences(userIdOrQuery) {
  let target = findUser(userIdOrQuery);
  if (!target) return null;
  return target.preferences || {};
}

function updateUserPreferences(userIdOrQuery, prefs) {
  let target = findUser(userIdOrQuery);
  if (!target) return null;
  if (!target.preferences || typeof target.preferences !== "object") {
    target.preferences = {};
  }
  if (prefs && typeof prefs === "object") {
    target.preferences = {
      ...target.preferences,
      ...prefs,
      updatedAt: new Date().toISOString()
    };
    saveJSON(USERS_FILE, users);
  }
  return target.preferences;
}

module.exports = {
  registerUser,
  loginUser,
  telegramAuth,
  getUserByToken,
  getUserByTelegramId,
  updateProfile,
  linkTelegramBot,
  setTelegramAlertsEnabledByChatId,
  isTelegramAlertsEnabled,
  getUserStats,
  setUserPlan,
  grantPlanForPayment,
  grantBulkProTime,
  subtractProTime,
  subtractBulkProTime,
  exportUsersExcel,
  getAuditLogs,
  findUser,
  searchUsers,
  blockUser,
  unblockUser,
  toggleUserTag,
  setUserNotes,
  revokeAllUserSessions,
  resetUserPassword,
  touchUserActivity,
  getAllUsersRaw,
  addNotificationToUser,
  markNotificationRead,
  getUserPreferences,
  updateUserPreferences
};
