"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const excelExporter = require("./excelExporter");

const USERS_FILE = path.join(__dirname, "users.json");
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const LOGS_FILE = path.join(__dirname, "auth_logs.json");

// Helper for atomic file write
function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    if (filePath === USERS_FILE) {
      excelExporter.generateUsersExcel(data);
    }
  } catch (err) {
    console.error(`[userStore] Error saving ${filePath}:`, err.message);
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

// Secure password hashing
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, storedHash) {
  const { hash } = hashPassword(password, salt);
  return hash === storedHash;
}

function cleanPassword(p) {
  return String(p || "").trim();
}

// Create session token
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { userId, createdAt: new Date().toISOString() };
  saveJSON(SESSIONS_FILE, sessions);
  return token;
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, salt, ...safe } = user;
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
  return safe;
}

// Register user with email/username & password
function registerUser({ username, email, password, ip = "" }) {
  if (!username || !email || !password) {
    throw new Error("Заполните все обязательные поля");
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanUsername = username.trim();

  if (cleanPassword(password).length < 8) {
    throw new Error("Пароль должен содержать минимум 8 символов");
  }

  // Check uniqueness
  for (const u of Object.values(users)) {
    if (u.email && u.email.toLowerCase() === cleanEmail) {
      throw new Error("Пользователь с таким Email уже зарегистрирован");
    }
  }

  const userId = generateUserId();
  const { hash, salt } = hashPassword(password);

  const newUser = {
    id: userId,
    username: cleanUsername,
    email: cleanEmail,
    passwordHash: hash,
    salt,
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

  const isValid = verifyPassword(password, foundUser.salt, foundUser.passwordHash);
  if (!isValid) {
    logAuthEvent({ event: "LOGIN_FAILED", userId: foundUser.id, query, ip, reason: "Invalid password" });
    throw new Error("Неверный логин или пароль");
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

// Validate session token
function getUserByToken(token) {
  if (!token || !sessions[token]) return null;
  const { userId } = sessions[token];
  return sanitizeUser(users[userId]);
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
  if (tgUsername) users[userId].telegramUsername = tgUsername;
  saveJSON(USERS_FILE, users);

  logAuthEvent({ event: "LINK_TELEGRAM_BOT", userId, chatId: String(chatId), tgUsername });
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
    target.proExpiresAt = Date.now() + (3650 - validDays) * 24 * 60 * 60 * 1000;
  } else {
    target.proExpiresAt = target.proExpiresAt - msToSub;
  }

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
  const { hash, salt } = hashPassword(newPassword);
  target.passwordHash = hash;
  target.salt = salt;
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

module.exports = {
  registerUser,
  loginUser,
  telegramAuth,
  getUserByToken,
  getUserByTelegramId,
  updateProfile,
  linkTelegramBot,
  getUserStats,
  setUserPlan,
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
  getAllUsersRaw
};
