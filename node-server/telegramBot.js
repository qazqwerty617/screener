"use strict";

const crypto = require("crypto");
const userStore = require("./userStore");

function getBotToken() { return String(process.env.TELEGRAM_BOT_TOKEN || "").trim(); }
function getAdminBotToken() { return String(process.env.ADMIN_BOT_TOKEN || "").trim(); }
function getAdminChatId() { return String(process.env.ADMIN_CHAT_ID || "").trim(); }
function getBotUsername() { return String(process.env.TELEGRAM_BOT_USERNAME || "ObsidianScreenerBot").trim(); }

// Map of one-time deep-link tokens -> userId
const linkTokens = new Map(); // token -> { userId, createdAt }

// Map of Telegram registration/login tokens -> { status: "pending" | "approved", token, user }
const regTokens = new Map();

// Verify Telegram Widget Authorization payload cryptographically
function verifyTelegramAuth(data) {
  const token = getBotToken();
  if (!token || !data || typeof data.hash !== "string" || !/^[a-fA-F0-9]{64}$/.test(data.hash)) return false;
  const authDate = Number(data.auth_date);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(authDate) || authDate > nowSeconds + 60 || nowSeconds - authDate > 24 * 60 * 60) return false;

  const secretKey = crypto.createHash("sha256").update(token).digest();
  
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
  if (!getBotToken()) throw new Error("Telegram bot is not configured");
  const token = crypto.randomBytes(24).toString("base64url");
  linkTokens.set(token, { userId, createdAt: Date.now() });
  setTimeout(() => linkTokens.delete(token), 15 * 60 * 1000).unref();
  return token;
}

// Generate registration/login start token
function createRegToken() {
  if (!getBotToken()) throw new Error("Telegram bot is not configured");
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

const chatAlertState = new Map();
const userSupportState = new Map();

function getDefaultKeyboard(chatId, tgUser) {
  let existingUser = userStore.getUserByTelegramId ? userStore.getUserByTelegramId(tgUser ? tgUser.id : null) : null;
  const isEnabled = existingUser ? (existingUser.tgAlertsEnabled !== false) : (chatAlertState.get(chatId) !== false);
  const btnText = isEnabled ? "🔔 Ценовые алерты: ✅ ВКЛ" : "🔕 Ценовые алерты: ❌ ВЫКЛ";

  return {
    inline_keyboard: [
      [{ text: "🔥 Топ монеты сейчас", callback_data: "top_coins" }],
      [{ text: btnText, callback_data: "toggle_alerts" }],
      [
        { text: "📊 Мой аккаунт", callback_data: "account_info" },
        { text: "💬 Поддержка", callback_data: "support_prompt" }
      ]
    ]
  };
}

const https = require("https");
// Shared keep-alive agent for both poll loops. Reusing TLS connections plus
// TCP keepalive probes keeps the 20s Telegram long-poll alive through NATs
// that silently drop idle sockets (the source of constant read ETIMEDOUT).
const tgPollAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 8,
  scheduling: "fifo"
});

async function userApiCall(method, payload) {
  const token = getBotToken();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_DISABLED" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(10000)
    });
    return await res.json();
  } catch (err) {
    console.error(`[USER BOT ERROR] API Call ${method} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Send message to Telegram Chat
async function sendTelegramMessage(chatId, text) {
  return await userApiCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
}

async function sendTelegramMessageWithKeyboard(chatId, text, replyMarkup) {
  return await userApiCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
}

function answerCallbackQuery(callbackQueryId, text) {
  if (!getBotToken() || !callbackQueryId) return;
  userApiCall("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

async function editMessageText(chatId, messageId, text, replyMarkup) {
  return await userApiCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
}

// Long polling engine to process incoming Telegram Bot messages
let offset = 0;
function pollUpdates() {
  const token = getBotToken();
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`;
  const req = https.get(url, { agent: tgPollAgent, timeout: 35000 }, (res) => {
    let body = "";
    res.on("data", (chunk) => body += chunk);
    res.on("end", () => {
      let hasUpdates = false;
      try {
        if (res.statusCode === 200) {
          const data = JSON.parse(body);
          if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
            hasUpdates = true;
            for (const update of data.result) {
              offset = update.update_id + 1;
              try {
                handleUpdate(update);
              } catch (err) {
                console.error("[USER BOT UPDATE ERROR]", err);
              }
            }
          }
        } else {
          console.warn(`[USER BOT POLL WARN] HTTP ${res.statusCode}: ${body}`);
        }
      } catch (err) {
        console.error("[USER BOT JSON ERR]", err.message);
      }
      setTimeout(pollUpdates, hasUpdates ? 0 : 200);
    });
  });
  req.on("socket", (socket) => socket.setKeepAlive(true, 10000));
  req.on("error", (err) => {
    console.error("[USER BOT POLL ERR]", err.message);
    setTimeout(pollUpdates, 400);
  });
  req.on("timeout", () => {
    req.destroy();
  });
}

function handleCallbackQuery(cb) {
  if (!cb || !cb.message) return;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const tgUser = cb.from || {};

  if (data === "toggle_alerts") {
    let existingUser = userStore.getUserByTelegramId ? userStore.getUserByTelegramId(tgUser.id) : null;
    let nextState = true;
    if (existingUser) {
      nextState = existingUser.tgAlertsEnabled === false ? true : false;
      if (typeof userStore.setTelegramAlertsEnabledByChatId === "function") {
        userStore.setTelegramAlertsEnabledByChatId(chatId, nextState);
      }
    } else {
      const current = chatAlertState.get(chatId);
      nextState = current === false ? true : false;
      chatAlertState.set(chatId, nextState);
    }

    const btnText = nextState ? "🔔 Ценовые алерты: ✅ ВКЛ" : "🔕 Ценовые алерты: ❌ ВЫКЛ";
    const statusText = nextState 
      ? "<b>✅ Уведомления о ценовых алертах ВКЛЮЧЕНЫ!</b>\n\nВсе выставляемые вами ценовые сигналы 🔔 на графике поступают в реальном времени." 
      : "<b>❌ Уведомления о ценовых алертах ВЫКЛЮЧЕНЫ.</b>\n\nСообщения о выставляемых уровнях цены временно приостановлены.";

    answerCallbackQuery(cb.id, nextState ? "Уведомления ВКЛЮЧЕНЫ ✅" : "Уведомления ВЫКЛЮЧЕНЫ ❌");
    editMessageText(chatId, messageId, statusText, getDefaultKeyboard(chatId, tgUser));
  } else if (data === "account_info") {
    let existingUser = userStore.getUserByTelegramId ? userStore.getUserByTelegramId(tgUser.id) : null;
    const isEnabled = existingUser ? (existingUser.tgAlertsEnabled !== false) : (chatAlertState.get(chatId) !== false);
    
    answerCallbackQuery(cb.id, "Информация о вашем профиле");
    sendTelegramMessageWithKeyboard(
      chatId,
      `<b>👤 Аккаунт Obsidian Pro</b>\n\n` +
      `• <b>ID:</b> <code>${existingUser ? existingUser.id : "—"}</code>\n` +
      `• <b>Пользователь:</b> ${existingUser ? existingUser.username : (tgUser.username ? "@" + tgUser.username : "Trader")}\n` +
      `• <b>Тариф:</b> ${existingUser && existingUser.plan === "pro" ? "💎 PRO" : "⚪ FREE"}\n` +
      `• <b>Ценовые алерты:</b> ${isEnabled ? "✅ Включены" : "❌ Выключены"}`,
      getDefaultKeyboard(chatId, tgUser)
    );
  } else if (data === "support_prompt") {
    userSupportState.set(chatId, { awaiting: true });
    answerCallbackQuery(cb.id, "Поддержка");
    sendTelegramMessage(
      chatId,
      `<b>💬 Техническая поддержка Obsidian Screener</b>\n\n` +
      `Напишите ваш вопрос или сообщение прямо сюда в чат 👇\n` +
      `Наш администратор получит его и ответит вам прямо в этом боте.`
    );
  } else if (data === "top_coins") {
    answerCallbackQuery(cb.id, "Загрузка топ монет...");
    const digest = buildMarketDigest();
    if (digest) {
      sendTelegramMessageWithKeyboard(chatId, digest, getDefaultKeyboard(chatId, tgUser));
    } else {
      sendTelegramMessageWithKeyboard(
        chatId,
        `<b>📊 Данные о рынке</b>\n\n<i>Рыночные данные загружаются, попробуйте через минуту...</i>`,
        getDefaultKeyboard(chatId, tgUser)
      );
    }
  }
}

async function getTelegramFileUrl(botToken, fileId) {
  if (!botToken || !fileId) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.result && data.result.file_path) {
        return `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
      }
    }
  } catch (e) {
    console.error("[TELEGRAM FILE FETCH ERROR]", e.message);
  }
  return null;
}

async function handleUpdate(update) {
  if (update.callback_query) {
    handleCallbackQuery(update.callback_query);
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const tgUser = msg.from || {};
  let text = (msg.text || msg.caption || "").trim();
  console.log(`[USER BOT MSG] From chatId=${chatId} (@${tgUser.username || "no_user"}): "${text}"`);
  let photoFileId = null;

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    photoFileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document) {
    photoFileId = msg.document.file_id;
  }

  if (!text && !photoFileId) return;

  let photoUrl = null;
  if (photoFileId) {
    photoUrl = await getTelegramFileUrl(getBotToken(), photoFileId);
  }

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const startParam = parts[1] ? parts[1].trim() : null;
    userSupportState.delete(chatId);

    const defaultKeyboard = getDefaultKeyboard(chatId, tgUser);

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

        sendTelegramMessageWithKeyboard(
          chatId,
          `<b>🎉 Telegram-уведомления Obsidian Screener подключены!</b>\n\n` +
          `<b>Пользователь:</b> ${authResult.user.username || "@" + (tgUser.username || "Trader")}\n` +
          `<b>Индивидуальный ID:</b> <code>${authResult.user.id}</code>\n\n` +
          `Вы подтвердили включение уведомлений о ценовых уровнях 🔔 на графике.\n` +
          `Они будут приходить в реальном времени, пока вы их не отключите.\n\n` +
          `<i>Настройка бота:</i>`,
          defaultKeyboard
        );

        if (authResult.isNew) {
          sendAdminNotification(authResult.user, { authMethod: "Telegram", ip: "" });
        }
      } catch (err) {
        sendTelegramMessage(chatId, `❌ Ошибка авторизации: ${err.message}`);
      }
    } else if (startParam && linkTokens.has(startParam)) {
      // Connect bot to existing user account
      const { userId } = linkTokens.get(startParam);
      linkTokens.delete(startParam);

      userStore.linkTelegramBot(userId, chatId, tgUser.username);
      sendTelegramMessageWithKeyboard(
        chatId,
        `<b>✅ Telegram-уведомления успешно подключены!</b>\n\n` +
        `Все ценовые алерты 🔔 с графика терминала будут поступать сюда в реальном времени.\n` +
        `Уведомления активны непрерывно, пока вы не отключите их кнопкой ниже.`,
        defaultKeyboard
      );
    } else {
      // Plain /start greeting
      const existingUser = userStore.getUserByTelegramId ? userStore.getUserByTelegramId(tgUser.id) : null;
      const isEnabled = existingUser ? (existingUser.tgAlertsEnabled !== false) : (chatAlertState.get(chatId) !== false);

      sendTelegramMessageWithKeyboard(
        chatId,
        `<b>👋 Терминал Obsidian Pro Bot</b>\n\n` +
        (existingUser 
          ? `<b>ID:</b> <code>${existingUser.id}</code>\n<b>Статус бота:</b> ${isEnabled ? "✅ Уведомления включены" : "❌ Уведомления выключены"}\n\nВы получаете сигналы о достижении цен 🔔 с графиков в реальном времени.`
          : `Нажмите «Подключить Telegram» в настройках терминала Obsidian.`),
        defaultKeyboard
      );
    }
  } else {
    // Non-command text/media message -> support ticket!
    userSupportState.delete(chatId);
    let existingUser = userStore.getUserByTelegramId ? userStore.getUserByTelegramId(tgUser.id) : null;
    const userId = existingUser ? existingUser.id : "—";
    const name = `${tgUser.first_name || ""} ${tgUser.last_name || ""}`.trim() || (existingUser ? existingUser.username : "Trader");
    const ticketText = text || "(Прикреплен скриншот / файл)";
    const safeText = ticketText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
    Promise.all([
      sendTelegramMessageWithKeyboard(
        chatId,
        `<b>✅ Ваш вопрос ${photoFileId ? "и скриншот отправлены" : "отправлен"} в поддержку!</b>\n\n` +
        `<b>Ваше сообщение:</b>\n<i>«${safeText}»</i>\n\n` +
        `Администратор ответит вам здесь в боте в ближайшее время.`,
        getDefaultKeyboard(chatId, tgUser)
      ),
      (adminBot && typeof adminBot.createSupportTicket === "function") 
        ? adminBot.createSupportTicket({
            chatId,
            userId,
            username: tgUser.username,
            name,
            text: ticketText,
            photoFileId,
            photoUrl
          })
        : Promise.resolve()
    ]).catch(err => console.error("[SUPPORT TRANSMIT ERROR]", err.message));
  }
}

let registrationCounter = 0;

async function sendAdminNotification(user, details = {}) {
  const adminToken = getAdminBotToken();
  const adminChatId = getAdminChatId();
  if (!user || !adminToken || !adminChatId) return;
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

    await fetch(`https://api.telegram.org/bot${adminToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminChatId,
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
function pollAdminUpdates() {
  const adminToken = getAdminBotToken();
  if (!adminToken) return;
  const url = `https://api.telegram.org/bot${adminToken}/getUpdates?offset=${adminOffset}&timeout=20`;
  const req = https.get(url, { agent: tgPollAgent, timeout: 35000 }, (res) => {
    let body = "";
    res.on("data", (chunk) => body += chunk);
    res.on("end", () => {
      let hasUpdates = false;
      try {
        if (res.statusCode === 200) {
          const data = JSON.parse(body);
          if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
            hasUpdates = true;
            for (const update of data.result) {
              adminOffset = update.update_id + 1;
              try {
                handleAdminUpdate(update);
              } catch (err) {
                console.error("[ADMIN BOT UPDATE ERROR]", err);
              }
            }
          }
        } else {
          console.warn(`[ADMIN BOT POLL WARN] HTTP ${res.statusCode}: ${body}`);
        }
      } catch (err) {
        console.error("[ADMIN BOT JSON ERR]", err.message);
      }
      setTimeout(pollAdminUpdates, hasUpdates ? 0 : 200);
    });
  });
  req.on("socket", (socket) => socket.setKeepAlive(true, 10000));
  req.on("error", (err) => {
    console.error("[ADMIN BOT POLL ERR]", err.message);
    setTimeout(pollAdminUpdates, 400);
  });
  req.on("timeout", () => {
    req.destroy();
  });
}

function handleAdminUpdate(update) {
  if (update.message) {
    console.log(`[ADMIN BOT MSG] From chatId=${update.message.chat.id}: "${update.message.text || ""}"`);
    adminBot.handleAdminMessageText(update.message);
  } else if (update.callback_query) {
    console.log(`[ADMIN BOT CB] From chatId=${update.callback_query.message ? update.callback_query.message.chat.id : ""}`);
    adminBot.handleAdminCallbackQuery(update.callback_query);
  }
}

async function sendAdminBotMessage(chatId, text) {
  try {
    const adminToken = getAdminBotToken();
    if (!adminToken || !chatId) return;
    await fetch(`https://api.telegram.org/bot${adminToken}/sendMessage`, {
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

// ─────────────────────────────────────────────────────────────────────────────
// DAILY MARKET DIGEST — Top volatile "in-play" coins at 09:00 & 21:00 MSK
// ─────────────────────────────────────────────────────────────────────────────

// Reference to server tickers Map — injected lazily to avoid circular deps
let _serverTickers = null;
function getServerTickers() {
  if (_serverTickers) return _serverTickers;
  try {
    // server.js stores tickers on global — we read from there
    _serverTickers = global.__obsidianTickers;
  } catch (_) {}
  return _serverTickers;
}

function getMarketWallsMap() {
  const wallsMap = new Map();
  try {
    const meta = global.__obsidianWallsMeta;
    if (meta && Array.isArray(meta.walls)) {
      for (const w of meta.walls) {
        if (!w || !w.sym || !w.usdValue) continue;
        const sym = w.sym.toUpperCase();
        let entry = wallsMap.get(sym);
        if (!entry) {
          entry = { bidWall: null, askWall: null };
          wallsMap.set(sym, entry);
        }
        if (w.type === "BID" && (!entry.bidWall || w.usdValue > entry.bidWall.usdValue)) {
          entry.bidWall = w;
        }
        if (w.type === "ASK" && (!entry.askWall || w.usdValue > entry.askWall.usdValue)) {
          entry.askWall = w;
        }
      }
    }
  } catch (_) {}
  return wallsMap;
}

function buildMarketDigest() {
  const tickersMap = getServerTickers();
  if (!tickersMap || tickersMap.size === 0) return null;

  const seen = new Map();
  for (const t of tickersMap.values()) {
    if (!t || !t.key || !t.p || t.p <= 0) continue;
    const parts = t.key.split(":");
    if (parts.length < 2) continue;
    const ex = parts[0];
    let sym = parts[1] || "";
    if (!sym || sym.length > 30) continue;

    let cleanSym = sym.toUpperCase()
      .replace(/[-_]SWAP$/i, "")
      .replace(/[-_]PERP$/i, "")
      .replace(/MUSDT$/i, "")
      .replace(/USDTM$/i, "")
      .replace(/[-_]/g, "");

    let base = cleanSym;
    if (base.endsWith("USDT")) base = base.slice(0, -4);
    else if (base.endsWith("USDC")) base = base.slice(0, -4);
    else if (base.endsWith("BUSD")) base = base.slice(0, -4);
    else if (base.endsWith("USD")) base = base.slice(0, -3);

    // Exclude stocks, tokenized equities, indices, fiat, and stablecoins (ONLY CRYPTO)
    if (
      !base || base.length < 2 ||
      /STOCK|INDEX|ETF|EQUITY/i.test(base) ||
      ["USDT", "USDC", "DAI", "BUSD", "FDUSD", "TUSD", "USDP", "USDE", "PYUSD", "USD1", "EUR1", "USDC1", "BTC1",
       "XAUT", "PAXG", "XAG", "XAU", "SILVER", "GOLD",
       "EUR", "GBP", "JPY", "AUD", "USD", "CHF", "TRY", "RUB", "BRL",
       "SPY", "QQQ", "AAPL", "TSLA", "NVDA", "AMZN", "MSFT", "GOOGL", "META", "NFLX"].includes(base)
    ) continue;

    const absChg = Math.abs(t.chg || 0);
    const existing = seen.get(base);
    if (!existing || (ex === "BN" && existing.ex !== "BN") || (ex === existing.ex && (t.v || 0) > (existing.v || 0))) {
      seen.set(base, { sym: `${base}USDT`, chg: t.chg || 0, p: t.p, v: t.v || 0, ex, absChg });
    }
  }

  if (seen.size === 0) return null;

  const inPlayCoins = [...seen.values()]
    .filter(d => d.absChg >= 2.5 && d.v >= 200000)
    .sort((a, b) => b.absChg - a.absChg);

  if (inPlayCoins.length === 0) {
    let text = `<b>Obsidian Screener</b>\n\n`;
    text += `<b>GM!</b>\n\n`;
    text += `Рынок сегодня спокойный. Аномальной волатильности не зафиксировано.`;
    return text;
  }

  const top = inPlayCoins.slice(0, 8);

  const tableRows = [];
  top.forEach(d => {
    const chgSign = d.chg >= 0 ? "+" : "";
    const chgStr = (chgSign + d.chg.toFixed(2) + "%").padEnd(9, " ");
    
    let volStr;
    if (d.v >= 1_000_000_000) volStr = (d.v / 1_000_000_000).toFixed(2) + "B$";
    else if (d.v >= 1_000_000) volStr = (d.v / 1_000_000).toFixed(2) + "M$";
    else if (d.v >= 1_000) volStr = (d.v / 1_000).toFixed(0) + "K$";
    else volStr = d.v.toFixed(0) + "$";

    const symStr = (`★ ${d.sym}`).padEnd(14, " ");
    tableRows.push(`${symStr} ${chgStr} ${volStr.padStart(9, " ")}`);
  });

  const now = new Date();
  const mskHour = (now.getUTCHours() + 3) % 24;
  const greeting = mskHour < 17 ? "GM!" : "GN!";

  let text = `<b>Obsidian Screener</b>\n\n`;
  text += `<pre>${tableRows.join("\n")}</pre>\n\n`;
  text += `<b>${greeting}</b>\n\n`;
  text += `<b>Внимание на эти тикеры 👀</b>\n\n`;
  text += `<i>Не финансовая рекомендация!</i>`;

  return text;
}

async function sendDigestToAllUsers() {
  const digestText = buildMarketDigest();
  if (!digestText) {
    console.log("[DIGEST] No data available for market digest");
    return;
  }

  const allUsers = Object.values(userStore.getAllUsersRaw());
  const recipients = allUsers.filter(u => u.telegramChatId && !u.blocked);

  let sent = 0;
  let failed = 0;

  for (const u of recipients) {
    try {
      const token = getBotToken();
      if (!token) break;
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: u.telegramChatId,
          text: digestText,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });
      if (res.ok) sent++;
      else failed++;
    } catch (_) {
      failed++;
    }
    // 50ms delay between messages to respect Telegram rate limits (30 msg/s)
    if (sent % 25 === 0) await new Promise(r => setTimeout(r, 50));
  }

  console.log(`[DIGEST] Market digest sent to ${sent}/${recipients.length} users (${failed} failed)`);
}

// Schedule daily digests at 09:00 and 21:00 MSK (UTC+3)
function scheduleDigest() {
  const checkInterval = 60_000; // check every 60 seconds
  let lastSentHour = -1;
  let lastSentDay = -1;

  setInterval(() => {
    const now = new Date();
    const mskHour = (now.getUTCHours() + 3) % 24;
    const mskDay = now.getUTCDate();
    const mskMinute = now.getUTCMinutes();

    // Send at HH:00 (first minute of the hour)
    if ((mskHour === 9 || mskHour === 21) && mskMinute === 0) {
      // Prevent double-send within same hour
      if (lastSentHour === mskHour && lastSentDay === mskDay) return;
      lastSentHour = mskHour;
      lastSentDay = mskDay;
      console.log(`[DIGEST] Sending ${mskHour === 9 ? "morning" : "evening"} market digest...`);
      sendDigestToAllUsers();
    }
  }, checkInterval);

  console.log("[DIGEST] Daily market digest scheduler active (09:00 & 21:00 MSK)");
}

if (process.env.DISABLE_TELEGRAM_BOT !== "true" && getBotToken()) {
  scheduleDigest();
}

// Start polling unless disabled
if (process.env.DISABLE_TELEGRAM_BOT !== "true" && getBotToken()) {
  pollUpdates();
  if (getAdminBotToken() && getAdminChatId()) pollAdminUpdates();
  console.log(`[TELEGRAM BOT] Engine initialized for @${getBotUsername()} & @ObsidianAdminBot`);
} else {
  console.log("[TELEGRAM BOT] Polling disabled or bot token is not configured");
}

module.exports = {
  get BOT_USERNAME() { return getBotUsername(); },
  verifyTelegramAuth,
  createLinkToken,
  createRegToken,
  getRegTokenStatus,
  sendTelegramMessage,
  sendAdminNotification,
  buildMarketDigest,
  sendDigestToAllUsers
};
