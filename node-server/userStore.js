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
const AUTH_LOG_LIMIT = 5000;

// Atomic, crash-resistant file write. Callers can fail closed on false.
let excelExportTimer = null;
function scheduleExcelExport(data) {
  if (excelExportTimer) return;
  excelExportTimer = setTimeout(() => {
    excelExportTimer = null;
    try { excelExporter.generateUsersExcel(data || users); } catch (_) {}
  }, 5 * 60 * 1000);
  if (excelExportTimer && typeof excelExportTimer.unref === "function") {
    excelExportTimer.unref();
  }
}

function saveJSON(filePath, data) {
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
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
      scheduleExcelExport(data);
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

/**
 * Coalescing async writer for the two files that are touched from request
 * handlers on nearly every authenticated call.
 *
 * `saveJSON` does openSync + writeFileSync + **fsyncSync** + renameSync. Calling
 * it from `getUserByToken` (session renewal), `logAuthEvent` (every new visit)
 * and a dozen mutators meant a blocking fsync — of a file that reached ~12 MB in
 * the case of auth_logs.json — inside the request path, stalling the 20 Hz
 * broadcast loop and every other in-flight request.
 *
 * Writes are now debounced and non-blocking. Durability is unchanged in
 * practice: the temp-file + rename dance still makes each write atomic, and the
 * `exit` hook below flushes anything still pending. Callers that must fail
 * closed on a persistence error (payments) keep using `saveJSON` directly.
 */
const DIRTY_FLUSH_MS = 400;
const pendingWrites = new Map(); // filePath -> { data, timer, inFlight, again }

function saveJSONDebounced(filePath, data) {
  const entry = pendingWrites.get(filePath);
  if (entry) {
    entry.data = data;
    if (entry.inFlight) entry.again = true;
    return true;
  }
  const next = { data, timer: null, inFlight: false, again: false };
  pendingWrites.set(filePath, next);
  next.timer = setTimeout(() => flushWrite(filePath), DIRTY_FLUSH_MS);
  next.timer.unref?.();
  return true;
}

function flushWrite(filePath) {
  const entry = pendingWrites.get(filePath);
  if (!entry || entry.inFlight) return;
  entry.timer = null;
  entry.inFlight = true;

  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let json;
  try {
    json = JSON.stringify(entry.data, null, 2);
  } catch (err) {
    pendingWrites.delete(filePath);
    console.error(`[userStore] Error serialising ${filePath}:`, err.message);
    return;
  }

  const done = (err) => {
    if (err) console.error(`[userStore] Error saving ${filePath}:`, err.message);
    entry.inFlight = false;
    if (entry.again) {
      entry.again = false;
      entry.timer = setTimeout(() => flushWrite(filePath), DIRTY_FLUSH_MS);
      entry.timer.unref?.();
    } else {
      pendingWrites.delete(filePath);
      if (!err && filePath === USERS_FILE) scheduleExcelExport(entry.data);
    }
  };

  fs.writeFile(tempPath, json, { mode: 0o600 }, (err) => {
    if (err) { fs.unlink(tempPath, () => {}); return done(err); }
    fs.rename(tempPath, filePath, (renameErr) => {
      if (renameErr) { fs.unlink(tempPath, () => {}); return done(renameErr); }
      done(null);
    });
  });
}

/** Flush every pending write synchronously. Used from the process `exit` hook. */
function flushPendingWritesSync() {
  for (const [filePath, entry] of pendingWrites) {
    if (entry.timer) clearTimeout(entry.timer);
    try { saveJSON(filePath, entry.data); } catch (_) {}
  }
  pendingWrites.clear();
}
process.once("exit", flushPendingWritesSync);
process.on("SIGTERM", flushPendingWritesSync);
process.on("SIGINT", flushPendingWritesSync);

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
let authLogs = loadJSON(LOGS_FILE, []); // Array of log objects, oldest first

// Older builds stored auth logs newest-first (they used `unshift`). Storage order
// is now ascending so appends are O(1); normalise a legacy file once on load.
if (Array.isArray(authLogs) && authLogs.length > 1) {
  const firstTs = Date.parse(authLogs[0]?.timestamp || "") || 0;
  const lastTs = Date.parse(authLogs[authLogs.length - 1]?.timestamp || "") || 0;
  if (firstTs > lastTs) authLogs.reverse();
} else if (!Array.isArray(authLogs)) {
  authLogs = [];
}

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

// Migrate & enrich user activity timestamps from sessions, logs, and preferences
(function migrateUserActivity() {
  let changed = false;
  for (const [userId, user] of Object.entries(users)) {
    if (!user || typeof user !== "object") continue;

    // 1. Find most recent session activity
    let latestSessionTime = 0;
    for (const session of Object.values(sessions)) {
      if (session && session.userId === userId) {
        const renewed = Number(session.lastRenewedAt) || 0;
        const created = Date.parse(session.createdAt || "") || 0;
        const best = Math.max(renewed, created);
        if (best > latestSessionTime) latestSessionTime = best;
      }
    }

    // 2. Find most recent auth log activity
    let latestLogTime = 0;
    if (Array.isArray(authLogs)) {
      for (const entry of authLogs) {
        if (entry && (entry.userId === userId || entry.username === user.username || entry.query === user.email)) {
          const t = Date.parse(entry.timestamp || "") || 0;
          if (t > latestLogTime) latestLogTime = t;
        }
      }
    }

    // 3. Find most recent preference update
    let latestPrefTime = 0;
    if (user.preferences && user.preferences.updatedAt) {
      latestPrefTime = Date.parse(user.preferences.updatedAt) || 0;
    }

    const bestRecentTime = Math.max(latestSessionTime, latestLogTime, latestPrefTime);

    if (bestRecentTime > 0) {
      const currentActiveMs = Date.parse(user.lastActive || "") || 0;
      if (bestRecentTime > currentActiveMs) {
        user.lastActive = new Date(bestRecentTime).toISOString();
        changed = true;
      }
      const currentLoginMs = Date.parse(user.lastLogin || "") || 0;
      if (bestRecentTime > currentLoginMs) {
        user.lastLogin = new Date(bestRecentTime).toISOString();
        changed = true;
      }
    }

    // Fallback: if lastActive or lastLogin is still completely missing, default to createdAt
    if (!user.lastActive) {
      user.lastActive = user.createdAt || new Date().toISOString();
      changed = true;
    }
    if (!user.lastLogin) {
      user.lastLogin = user.createdAt || new Date().toISOString();
      changed = true;
    }
  }

  if (changed) saveJSON(USERS_FILE, users);
})();

let pendingUserSave = false;
let userSaveTimer = null;

function scheduleUsersSave() {
  if (pendingUserSave) return;
  pendingUserSave = true;
  if (!userSaveTimer) {
    userSaveTimer = setTimeout(() => {
      pendingUserSave = false;
      userSaveTimer = null;
      saveJSONDebounced(USERS_FILE, users);
    }, 5000);
    if (userSaveTimer && typeof userSaveTimer.unref === "function") {
      userSaveTimer.unref();
    }
  }
}

function logAuthEvent(eventData) {
  const logEntry = {
    id: crypto.randomBytes(8).toString("hex"),
    timestamp: new Date().toISOString(),
    ...eventData
  };
  // `unshift` is O(n) on a 5000-element array and ran on every new visit. `push`
  // + a reversed read in `getAuditLogs`/`getUserAuthLogs` is O(1).
  authLogs.push(logEntry);
  if (authLogs.length > AUTH_LOG_LIMIT * 2) {
    // Amortised trim: splice once every 5000 entries instead of on every write.
    authLogs.splice(0, authLogs.length - AUTH_LOG_LIMIT);
  }
  saveJSONDebounced(LOGS_FILE, authLogs);
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
//
// scrypt with N=32768,r=8 is ~32 MB and ~100 ms of pure CPU. `scryptSync` blocks
// the event loop for that whole time, which stalls the 20 Hz market broadcast and
// every other in-flight request on each login/registration attempt — a
// distributed credential-stuffing attempt could keep the process permanently
// stalled. The async form runs on the libuv threadpool instead.
const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

function hashPassword(password, salt) {
  const passwordText = String(password);
  const saltBuffer = salt ? Buffer.from(salt, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(passwordText, saltBuffer, 64, SCRYPT_PARAMS).toString("hex");
  return { hash, salt: saltBuffer.toString("hex"), algorithm: PASSWORD_ALGORITHM };
}

function hashPasswordAsync(password, salt) {
  const passwordText = String(password);
  const saltBuffer = salt ? Buffer.from(salt, "hex") : crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(passwordText, saltBuffer, 64, SCRYPT_PARAMS, (err, derived) => {
      if (err) return reject(err);
      resolve({ hash: derived.toString("hex"), salt: saltBuffer.toString("hex"), algorithm: PASSWORD_ALGORITHM });
    });
  });
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

async function verifyPasswordAsync(password, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  if (user.passwordAlgorithm === PASSWORD_ALGORITHM) {
    const { hash } = await hashPasswordAsync(password, user.salt);
    return timingSafeHexEqual(hash, user.passwordHash);
  }
  const legacyHash = await new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), user.salt, 10000, 64, "sha512", (err, derived) => {
      if (err) return reject(err);
      resolve(derived.toString("hex"));
    });
  });
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
  // Auto-downgrade expired PRO subscriptions
  if (safe.plan === "pro" && user.proExpiresAt && Number.isFinite(user.proExpiresAt) && user.proExpiresAt <= Date.now()) {
    safe.plan = "free";
    safe.proDaysLeft = null;
    // Persist the downgrade in the source user object
    user.plan = "free";
    user.hadPro = true;
    delete user.proExpiresAt;
    saveJSONDebounced(USERS_FILE, users);
  } else if (safe.plan === "pro") {
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

// Register user with email/username & password.
// Async because scrypt (32 MB / ~100 ms) must not block the event loop.
async function registerUser({ username, email, password, ip = "" }) {
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

  // Check uniqueness (`for..in` avoids materialising an array of every user)
  for (const id in users) {
    const u = users[id];
    if (u && u.email && u.email.toLowerCase() === cleanEmail) {
      throw new Error("Пользователь с таким Email уже зарегистрирован");
    }
  }

  const userId = generateUserId();
  const { hash, salt, algorithm } = await hashPasswordAsync(passwordText);

  // Re-check after the await: a concurrent registration could have taken the
  // same address while scrypt was running on the threadpool.
  for (const id in users) {
    const u = users[id];
    if (u && u.email && u.email.toLowerCase() === cleanEmail) {
      throw new Error("Пользователь с таким Email уже зарегистрирован");
    }
  }

  const nowIso = new Date().toISOString();
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
    createdAt: nowIso,
    lastActive: nowIso,
    lastLogin: nowIso,
    lastIp: ip,
    avatar: ""
  };

  users[userId] = newUser;
  // Registration is rare and must be durable before the token is handed out.
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
async function loginUser({ emailOrUsername, password, ip = "" }) {
  if (!emailOrUsername || !password) {
    throw new Error("Укажите логин/email и пароль");
  }

  const query = emailOrUsername.trim().toLowerCase();
  let foundUser = null;

  for (const id in users) {
    const u = users[id];
    if (!u) continue;
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
  const isValid = await verifyPasswordAsync(passwordText, foundUser);
  if (!isValid) {
    logAuthEvent({ event: "LOGIN_FAILED", userId: foundUser.id, query, ip, reason: "Invalid password" });
    throw new Error("Неверный логин или пароль");
  }

  if (foundUser.passwordAlgorithm !== PASSWORD_ALGORITHM) {
    const upgraded = await hashPasswordAsync(passwordText);
    foundUser.passwordHash = upgraded.hash;
    foundUser.salt = upgraded.salt;
    foundUser.passwordAlgorithm = upgraded.algorithm;
  }

  const nowIso = new Date().toISOString();
  foundUser.lastLogin = nowIso;
  foundUser.lastActive = nowIso;
  if (ip) foundUser.lastIp = ip;
  saveJSONDebounced(USERS_FILE, users);

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
  const nowIso = new Date().toISOString();

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
      createdAt: nowIso,
      lastActive: nowIso,
      lastLogin: nowIso,
      lastIp: ip,
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
    foundUser.lastActive = nowIso;
    foundUser.lastLogin = nowIso;
    if (ip) foundUser.lastIp = ip;
    modified = true;

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
function getUserByToken(token, { ip = "" } = {}) {
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
    // Debounced: this runs on the request path, once per authenticated call.
    saveJSONDebounced(SESSIONS_FILE, sessions);
  }
  // Disk-reload fallback: if session not in memory (e.g. after PM2 restart race),
  // re-read sessions.json from disk once and try again.
  if (!session) {
    try {
      const diskSessions = loadJSON(SESSIONS_FILE, {});
      if (diskSessions[tokenHash]) {
        sessions[tokenHash] = diskSessions[tokenHash];
        session = sessions[tokenHash];
        sessionKey = tokenHash;
      } else if (diskSessions[token]) {
        sessions[tokenHash] = diskSessions[token];
        session = sessions[tokenHash];
        sessionKey = tokenHash;
        saveJSONDebounced(SESSIONS_FILE, sessions);
      }
    } catch (_) {}
  }
  if (!session) return null;
  const now = Date.now();
  const createdAt = Date.parse(session.createdAt || "");
  const expiresAt = Number(session.expiresAt) || (createdAt + SESSION_TTL_MS);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    delete sessions[sessionKey];
    saveJSONDebounced(SESSIONS_FILE, sessions);
    return null;
  }

  // Sliding Session Renewal: Automatically renew 365 days every 6 hours of user activity
  if (now - (session.lastRenewedAt || 0) > 6 * 60 * 60 * 1000) {
    session.expiresAt = now + SESSION_TTL_MS;
    session.lastRenewedAt = now;
    saveJSONDebounced(SESSIONS_FILE, sessions);
  }

  const user = users[session.userId];
  if (!user) return null;
  if (user.blocked && (!user.blockExpiresAt || user.blockExpiresAt > now)) return null;

  // Touch real-time user activity
  touchUserActivity(session.userId, { ip });

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
  // Request path (POST /api/auth/update-profile) — debounced.
  saveJSONDebounced(USERS_FILE, users);

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

// Persist a Telegram chat id entered manually in the web UI. Routes must call
// this instead of assigning onto the object returned by getUserByToken, which is
// a sanitized *copy* — writes to it are silently discarded and the user ends up
// subscribed with no deliverable address.
function setTelegramChatId(userId, chatId) {
  if (!userId || !users[userId]) return false;
  const strId = String(chatId || "").trim();
  if (!strId) return false;
  if (users[userId].telegramChatId === strId && users[userId].telegramId === strId) return true;
  users[userId].telegramChatId = strId;
  users[userId].telegramId = strId;
  // Request path (settings save) — debounced.
  return saveJSONDebounced(USERS_FILE, users);
}

// Persist a user's price alert list on the real record.
function setUserPriceAlerts(userId, alerts) {
  if (!userId || !users[userId]) return false;
  users[userId].priceAlerts = Array.isArray(alerts) ? alerts : [];
  // Request path (POST /api/user/price-alerts) — debounced.
  return saveJSONDebounced(USERS_FILE, users);
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
  let target = users[userIdOrTgId] || findUser(userIdOrTgId);
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
  broadcastUserUpdate(target.id);
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

function grantGiftDays(userIdOrTgId, promoCode, days) {
  let target = users[userIdOrTgId] || findUser(userIdOrTgId);
  if (!target) return null;
  const cleanCode = String(promoCode || "").trim().toUpperCase();
  const validDays = Number(days);
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 3650) {
    throw new Error("Invalid promo days duration");
  }

  if (!Array.isArray(target.redeemedPromos)) target.redeemedPromos = [];
  if (cleanCode && target.redeemedPromos.includes(cleanCode)) {
    return { user: sanitizeUser(target), applied: false, alreadyUsed: true };
  }

  const wasLifetime = target.plan === "pro" && !target.proExpiresAt;
  target.plan = "pro";
  if (validDays >= 8000 || wasLifetime) {
    delete target.proExpiresAt;
  } else {
    const currentExpiry = (Number.isFinite(target.proExpiresAt) && target.proExpiresAt > Date.now())
      ? target.proExpiresAt
      : Date.now();
    target.proExpiresAt = currentExpiry + validDays * 24 * 60 * 60 * 1000;
  }

  if (cleanCode) target.redeemedPromos.push(cleanCode);

  saveJSON(USERS_FILE, users);
  logAuthEvent({ event: "GIFT_PROMO_REDEEM", userId: target.id, promoCode: cleanCode, days: validDays });
  broadcastUserUpdate(target.id);
  return { user: sanitizeUser(target), applied: true, days: validDays };
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
  broadcastUserUpdate(target.id);
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
  const raw = String(query).trim();
  const q = raw.toLowerCase().replace(/^@/, "");
  const qUpper = q.toUpperCase();

  // 1. Direct ID match
  if (users[raw]) return users[raw];
  if (users[qUpper]) return users[qUpper];
  if (users[q]) return users[q];

  for (const u of Object.values(users)) {
    if (
      (u.id && u.id.toUpperCase() === qUpper) ||
      (u.username && (u.username.toLowerCase() === q || u.username.toLowerCase() === `@${q}`)) ||
      (u.telegramId && String(u.telegramId) === q) ||
      (u.telegramChatId && String(u.telegramChatId) === q) ||
      (u.email && u.email.toLowerCase() === q) ||
      (u.telegramUsername && (u.telegramUsername.toLowerCase() === q || u.telegramUsername.toLowerCase() === `@${q}`))
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
      (u.telegramChatId && String(u.telegramChatId).includes(q)) ||
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.telegramUsername && u.telegramUsername.toLowerCase().includes(q))
    ) {
      results.push(u);
    }
  }

  results.sort((a, b) => {
    const aOnline = isUserOnline(a.id) ? 1 : 0;
    const bOnline = isUserOnline(b.id) ? 1 : 0;
    if (bOnline !== aOnline) return bOnline - aOnline;

    const aPro = (a.plan === "pro" && (!a.proExpiresAt || a.proExpiresAt > Date.now())) ? 1 : 0;
    const bPro = (b.plan === "pro" && (!b.proExpiresAt || b.proExpiresAt > Date.now())) ? 1 : 0;
    if (bPro !== aPro) return bPro - aPro;

    const aTime = Date.parse(a.lastActive || a.lastLogin || a.createdAt || "") || 0;
    const bTime = Date.parse(b.lastActive || b.lastLogin || b.createdAt || "") || 0;
    return bTime - aTime;
  });

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

// ── Real-Time Online Socket Registry ──
const activeSocketsByUserId = new Map(); // userId -> Set<ws>
const activeGuestSockets = new Set();    // Set<ws>

function registerActiveSocket(userId, ws, ip = "") {
  if (!ws) return;
  const cleanIp = ip ? String(ip).replace(/^::ffff:/, "") : "";
  if (userId && users[userId]) {
    activeGuestSockets.delete(ws);
    let set = activeSocketsByUserId.get(userId);
    if (!set) {
      set = new Set();
      activeSocketsByUserId.set(userId, set);
    }
    set.add(ws);
    touchUserActivity(userId, { ip: cleanIp });
  } else {
    activeGuestSockets.add(ws);
  }
}

function unregisterActiveSocket(userId, ws) {
  if (!ws) return;
  activeGuestSockets.delete(ws);
  if (userId) {
    const set = activeSocketsByUserId.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) activeSocketsByUserId.delete(userId);
    }
    if (users[userId]) {
      users[userId].lastActive = new Date().toISOString();
      scheduleUsersSave();
    }
  } else {
    for (const [uId, set] of activeSocketsByUserId.entries()) {
      if (set.has(ws)) {
        set.delete(ws);
        if (set.size === 0) activeSocketsByUserId.delete(uId);
        if (users[uId]) {
          users[uId].lastActive = new Date().toISOString();
          scheduleUsersSave();
        }
      }
    }
  }
}

function broadcastUserUpdate(userId) {
  if (!userId) return;
  const target = users[userId];
  if (!target) return;
  const set = activeSocketsByUserId.get(target.id);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ type: "user_updated", user: sanitizeUser(target) });
  for (const ws of set) {
    try {
      if (ws && ws.readyState === 1) ws.send(payload);
    } catch (_) {}
  }
}

function isUserOnline(userId) {
  if (!userId || !users[userId]) return false;
  const set = activeSocketsByUserId.get(userId);
  if (set && set.size > 0) return true;
  const user = users[userId];
  const lastTime = Date.parse(user.lastActive || user.lastLogin || "") || 0;
  if (!lastTime) return false;
  return (Date.now() - lastTime) < 5 * 60 * 1000;
}

function getOnlineStats() {
  const all = Object.values(users);
  const onlineUsersCount = all.filter(u => isUserOnline(u.id)).length;
  for (const ws of activeGuestSockets) {
    if (!ws || ws.readyState !== 1) activeGuestSockets.delete(ws);
  }
  const onlineGuestsCount = activeGuestSockets.size;
  return {
    onlineUsersCount,
    onlineGuestsCount,
    totalOnline: onlineUsersCount + onlineGuestsCount
  };
}

function getUserAuthLogs(userId, limit = 5) {
  if (!Array.isArray(authLogs) || !userId) return [];
  const u = users[userId];
  const uname = u ? u.username : "";
  // Storage is oldest-first; walk backwards so callers still get newest-first.
  const out = [];
  for (let i = authLogs.length - 1; i >= 0 && out.length < limit; i--) {
    const e = authLogs[i];
    if (e && (e.userId === userId || (uname && e.username === uname))) out.push(e);
  }
  return out;
}

function touchUserActivity(userId, { isLogin = false, ip = "", forceSave = false } = {}) {
  if (!userId || !users[userId]) return;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const user = users[userId];

  // Check if this constitutes a new visit / session start:
  // - Explicit login (isLogin === true)
  // - No lastLogin recorded yet
  // - Inactivity for more than 30 minutes since last recorded activity
  const prevActiveMs = Date.parse(user.lastActive || user.lastLogin || "") || 0;
  const wasAwayLong = (now - prevActiveMs) > 30 * 60 * 1000;

  if (isLogin || !user.lastLogin || wasAwayLong) {
    user.lastLogin = nowIso;
    try {
      logAuthEvent({
        event: isLogin ? "LOGIN_SUCCESS" : "SESSION_VISIT",
        userId: user.id,
        username: user.username,
        ip: (ip || user.lastIp || "").replace(/^::ffff:/, "")
      });
    } catch (_) {}
  }

  user.lastActive = nowIso;

  if (ip && typeof ip === "string") {
    user.lastIp = ip.replace(/^::ffff:/, "");
  }

  if (forceSave || isLogin) {
    // Still debounced — this is called from `getUserByToken`, i.e. on every
    // authenticated request. A blocking fsync here stalled the whole process.
    saveJSONDebounced(USERS_FILE, users);
  } else {
    scheduleUsersSave();
  }
}

function getAllUsersRaw() {
  return users;
}

function getAuditLogs(limit = AUTH_LOG_LIMIT) {
  // Newest-first for the admin UI, capped so the response cannot balloon.
  const n = Math.min(Array.isArray(authLogs) ? authLogs.length : 0, Math.max(1, limit));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = authLogs[authLogs.length - 1 - i];
  return out;
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
    // Request path (POST /api/notifications/mark-read) — debounced.
    saveJSONDebounced(USERS_FILE, users);
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
    // Request path (POST /api/user/preferences) — debounced.
    saveJSONDebounced(USERS_FILE, users);
  }
  return target.preferences;
}

/** Proactive sweep: downgrade all users whose PRO subscription has expired. */
function expireProSubscriptions() {
  const now = Date.now();
  let count = 0;
  for (const userId of Object.keys(users)) {
    const u = users[userId];
    if (u.plan === "pro" && u.proExpiresAt && Number.isFinite(u.proExpiresAt) && u.proExpiresAt <= now) {
      u.plan = "free";
      u.hadPro = true;
      delete u.proExpiresAt;
      count++;
    }
  }
  if (count > 0) {
    saveJSONDebounced(USERS_FILE, users);
    console.log(`[userStore] expireProSubscriptions: downgraded ${count} expired PRO user(s)`);
  }
  return count;
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
  setTelegramChatId,
  setUserPriceAlerts,
  getUserStats,
  setUserPlan,
  grantPlanForPayment,
  grantGiftDays,
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
  registerActiveSocket,
  unregisterActiveSocket,
  isUserOnline,
  getOnlineStats,
  getUserAuthLogs,
  addNotificationToUser,
  markNotificationRead,
  getUserPreferences,
  updateUserPreferences,
  broadcastUserUpdate,
  expireProSubscriptions
};
