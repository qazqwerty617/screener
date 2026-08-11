"use strict";

const crypto = require("crypto");
const userStore = require("./userStore");

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || "ObsidianScreenerBot").trim();
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Map of one-time deep-link tokens -> userId
const linkTokens = new Map(); // token -> { userId, createdAt }

// Map of Telegram registration/login tokens -> { status: "pending" | "approved", token, user }
const regTokens = new Map();

// Verify Telegram Widget Authorization payload cryptographically
function verifyTelegramAuth(data) {
  if (!BOT_TOKEN || !data || typeof data.hash !== "string" || !/^[a-fA-F0-9]{64}$/.test(data.hash)) return false;
  const authDate = Number(data.auth_date);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(authDate) || authDate > nowSeconds + 60 || nowSeconds - authDate > 24 * 60 * 60) return false;

  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  
  const checkArr = [];
  for (const key of Object.keys(data).sort()) {
    if (key !== "hash" && data[key] !== undefined && data[key] !== null) {
      checkArr.push(`${key}=${data[key]}`);
    }
  }
  const checkString = checkArr.join("\n");
  
  const hmac = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  const expected = Buffer.from(hmac, "hex");
  const supplied = Buffer.from(data.hash, "hex");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

// Generate one-time deep link token for connecting Telegram bot to user account
function createLinkToken(userId) {
  if (!BOT_TOKEN) throw new Error("Telegram bot is not configured");
  const token = crypto.randomBytes(24).toString("base64url");
  linkTokens.set(token, { userId, createdAt: Date.now() });
  setTimeout(() => linkTokens.delete(token), 15 * 60 * 1000).unref();
  return token;
}

// Generate registration/login start token
function createRegToken() {
  if (!BOT_TOKEN) throw new Error("Telegram bot is not configured");
  const token = "reg_" + crypto.randomBytes(24).toString("base64url");
  regTokens.set(token, { status: "pending", token: null, user: null, createdAt: Date.now() });
  setTimeout(() => regTokens.delete(token), 10 * 60 * 1000).unref();
  return token;
}

function getRegTokenStatus(token) {
  if (!token || !regTokens.has(token)) {
    return { status: "expired" };
  }
  const result = regTokens.get(token);
  if (result.status === "approved") regTokens.delete(token);
  return result;
}

// Send message to Telegram Chat
async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_DISABLED" };
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      })
    });
    return await res.json();
  } catch (err) {
    console.error("[TELEGRAM BOT ERROR] Failed to send message:", err.message);
  }
}

// Long polling engine to process incoming Telegram Bot messages
let offset = 0;
async function pollUpdates() {
  try {
    const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${offset}&timeout=20`, {
      signal: AbortSignal.timeout(25000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          handleUpdate(update);
        }
      }
    }
  } catch (e) {
    // Ignore timeout / network aborts
  } finally {
    setTimeout(pollUpdates, 1000);
  }
}

function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const tgUser = msg.from || {};

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const startParam = parts[1] ? parts[1].trim() : null;

    if (startParam && startParam.startsWith("reg_") && regTokens.has(startParam)) {
      // Direct registration / login via Telegram Bot
      try {
        const tgData = {
          id: tgUser.id,
          first_name: tgUser.first_name,
          last_name: tgUser.last_name,
          username: tgUser.username,
          photo_url: ""
        };
        const authResult = userStore.telegramAuth(tgData, chatId);
        regTokens.set(startParam, {
          status: "approved",
          token: authResult.token,
          user: authResult.user,
          createdAt: Date.now()
        });

        if (authResult.isNew) {
          sendAdminNotification(authResult.user, { authMethod: "Telegram", ip: "" });
          sendTelegramMessage(
            chatId,
            `<b>🎉 Новый аккаунт успешно создан в Obsidian Pro!</b>\n\n` +
            `<b>Индивидуальный ID:</b> <code>${authResult.user.id}</code>\n` +
            `<b>Пользователь:</b> ${authResult.user.username}\n` +
            `<b>Уведомления бота:</b> ✅ Подключены\n\n` +
            `Добро пожаловать! Возвращайтесь на сайт — терминал открыт.`
          );
        } else {
          sendTelegramMessage(
            chatId,
            `<b>👋 С возвращением в Obsidian Pro!</b>\n\n` +
            `<b>Индивидуальный ID:</b> <code>${authResult.user.id}</code>\n` +
            `<b>Пользователь:</b> ${authResult.user.username}\n` +
            `<b>Способ входа:</b> Telegram\n\n` +
            `Сессия входа активирована. Перейдите в браузер — терминал открыт.`
          );
        }
      } catch (err) {
        sendTelegramMessage(chatId, `❌ Ошибка авторизации: ${err.message}`);
      }
    } else if (startParam && linkTokens.has(startParam)) {
      // Connect bot to existing user account
      const { userId } = linkTokens.get(startParam);
      linkTokens.delete(startParam);

      userStore.linkTelegramBot(userId, chatId, tgUser.username);
      sendTelegramMessage(
        chatId,
        `<b>✅ Telegram-бот успешно подключён!</b>\n\nТеперь вы будете получать уведомления терминала Obsidian Pro прямо здесь.`
      );
    } else {
      // Plain /start greeting - check if user already exists
      const existingUser = userStore.getUserByTelegramId(tgUser.id);
      if (existingUser) {
        sendTelegramMessage(
          chatId,
          `<b>👋 С возвращением в Obsidian Pro Bot!</b>\n\n` +
          `<b>Ваш Индивидуальный ID:</b> <code>${existingUser.id}</code>\n` +
          `<b>Пользователь:</b> ${existingUser.username}\n` +
          `<b>Уведомления:</b> ✅ Подключены\n\n` +
          `Для автоматического входа нажмите <i>«Войти через Telegram»</i> на сайте.`
        );
      } else {
        sendTelegramMessage(
          chatId,
          `<b>👋 Добро пожаловать в Obsidian Pro Bot!</b>\n\n` +
          `Для быстрой регистрации и входа откройте терминал Obsidian и нажмите кнопку <i>«Войти через Telegram»</i>.`
        );
      }
    }
  }
}

const ADMIN_BOT_TOKEN = String(process.env.ADMIN_BOT_TOKEN || "").trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "").trim();
const ADMIN_TELEGRAM_API = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}`;

let registrationCounter = 0;

async function sendAdminNotification(user, details = {}) {
  if (!user || !ADMIN_BOT_TOKEN || !ADMIN_CHAT_ID) return;
  registrationCounter++;

  // Only send notification every 10 new user registrations
  if (registrationCounter % 10 !== 0) {
    return;
  }

  try {
    const stats = userStore.getUserStats();
    const method = details.authMethod || user.authMethod || "Логин / Пароль";

    const text =
      `🎉 <b>ОТЧЁТ: +10 НОВЫХ РЕГИСТРАЦИЙ!</b>\n\n` +
      `<b>📊 ОБЩАЯ СТАТИСТИКА СКРИНЕРА:</b>\n` +
      `• Всего пользователей: <b>${stats.total}</b>\n` +
      `• 💎 PRO подписок: <b>${stats.proCount}</b>\n` +
      `• ⚪ FREE аккаунтов: <b>${stats.freeCount}</b>\n` +
      `• 🆕 Новых за 24 часа: <b>${stats.registered24h}</b>\n\n` +
      `<b>👤 Трейдер #${registrationCounter} (10-й):</b>\n` +
      `• ID: <code>${user.id}</code>\n` +
      `• Имя: <b>${user.username || "—"}</b>\n` +
      `• Способ: ${method}\n` +
      `• Время: ${new Date().toLocaleString("ru-RU")}`;

    await fetch(`${ADMIN_TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.error("[ADMIN BOT ERROR] Failed to send admin alert:", err.message);
  }
}

const adminBot = require("./adminBot");

// Admin Bot Command Polling Engine
let adminOffset = 0;
async function pollAdminUpdates() {
  try {
    const res = await fetch(`${ADMIN_TELEGRAM_API}/getUpdates?offset=${adminOffset}&timeout=20`, {
      signal: AbortSignal.timeout(25000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          adminOffset = update.update_id + 1;
          handleAdminUpdate(update);
        }
      }
    }
  } catch (e) {
    // Ignore timeout / network aborts
  } finally {
    setTimeout(pollAdminUpdates, 1000);
  }
}

function handleAdminUpdate(update) {
  if (update.message) {
    adminBot.handleAdminMessageText(update.message);
  } else if (update.callback_query) {
    adminBot.handleAdminCallbackQuery(update.callback_query);
  }
}

async function sendAdminBotMessage(chatId, text) {
  try {
    await fetch(`${ADMIN_TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.error("[ADMIN BOT ERROR] Failed to send message:", err.message);
  }
}

// Start polling unless disabled
if (process.env.DISABLE_TELEGRAM_BOT !== "true" && BOT_TOKEN) {
  pollUpdates();
  if (ADMIN_BOT_TOKEN && ADMIN_CHAT_ID) pollAdminUpdates();
  console.log(`[TELEGRAM BOT] Engine initialized for @${BOT_USERNAME} & @ObsidianAdminBot`);
} else {
  console.log("[TELEGRAM BOT] Polling disabled or bot token is not configured");
}

module.exports = {
  BOT_USERNAME,
  verifyTelegramAuth,
  createLinkToken,
  createRegToken,
  getRegTokenStatus,
  sendTelegramMessage,
  sendAdminNotification
};
