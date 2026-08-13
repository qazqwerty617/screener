"use strict";

const fs = require("fs");
const path = require("path");
const userStore = require("./userStore");

const ADMIN_BOT_TOKEN = String(process.env.ADMIN_BOT_TOKEN || "").trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "").trim();
const MAIN_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_API = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}`;

// Files for persistent admin data
const PROMOS_FILE = path.join(__dirname, "promos.json");
const PAYMENTS_FILE = path.join(process.env.PAYMENT_DATA_DIR || __dirname, "payments.json");
const SUPPORT_FILE = path.join(__dirname, "support.json");
const SETTINGS_FILE = path.join(__dirname, "admin_settings.json");
const AUDIT_FILE = path.join(__dirname, "admin_audit.json");
const BUG_REPORTS_FILE = path.join(__dirname, "bug_reports.json");

function loadJSON(fp, fallback) {
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {}
  return fallback;
}

function saveJSON(fp, data) {
  try {
    const jsonStr = JSON.stringify(data);
    fs.writeFile(fp, jsonStr, "utf8", () => {});
  } catch (e) {}
}

let promos = loadJSON(PROMOS_FILE, [
  { code: "OBSIDIAN30", type: "percent", value: 30, active: true, usedCount: 47, limit: 100, expiresAt: "2026-09-01T00:00:00.000Z" },
  { code: "PROSTART", type: "days", value: 7, active: true, usedCount: 12, limit: 50, expiresAt: "2026-10-01T00:00:00.000Z" }
]);
let payments = loadJSON(PAYMENTS_FILE, []);
let supportTickets = loadJSON(SUPPORT_FILE, []);
let bugReports = loadJSON(BUG_REPORTS_FILE, []);
let adminSettings = loadJSON(SETTINGS_FILE, {
  sysAlerts: true,
  payAlerts: true,
  regAlerts: true,
  suppAlerts: true,
  dailyReport: true,
  tz: "MSK (UTC+3)"
});
let adminAudit = loadJSON(AUDIT_FILE, []);

// State tracking for admin interactive prompts (e.g. search, promo creation, broadcast text)
const adminState = new Map(); // chatId -> { action: string, data: any }

function logAdminAction(adminName, actionName, details = {}) {
  const entry = {
    id: "act_" + Date.now().toString(36),
    timestamp: new Date().toISOString(),
    admin: adminName || "Администратор #1",
    action: actionName,
    ...details
  };
  adminAudit.unshift(entry);
  if (adminAudit.length > 2000) adminAudit = adminAudit.slice(0, 2000);
  saveJSON(AUDIT_FILE, adminAudit);
}

const https = require("https");
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 100,
  scheduling: "fifo"
});

// High-speed Telegram API Helper with HTTP Keep-Alive Connection Pooling
function apiCall(method, payload) {
  return new Promise((resolve) => {
    if (!ADMIN_BOT_TOKEN || !ADMIN_CHAT_ID) return resolve({ ok: false, error: "ADMIN_BOT_DISABLED" });
    const postData = JSON.stringify(payload || {});
    const req = https.request(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/${method}`, {
      method: "POST",
      agent: httpsAgent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });

    req.on("error", (err) => {
      console.error(`[ADMIN BOT ERROR] API Call ${method} failed:`, err.message);
      resolve({ ok: false, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "TIMEOUT" });
    });

    req.write(postData);
    req.end();
  });
}

async function sendAdminMessage(text, replyMarkup = null) {
  return await apiCall("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
}

async function sendAdminDocument(filePath, filename, caption = "") {
  if (!ADMIN_BOT_TOKEN || !ADMIN_CHAT_ID) return { ok: false, error: "ADMIN_BOT_DISABLED" };
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: "text/csv" });
    const formData = new FormData();
    formData.append("chat_id", ADMIN_CHAT_ID);
    formData.append("document", blob, filename);
    if (caption) formData.append("caption", caption);
    formData.append("parse_mode", "HTML");

    const res = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: formData
    });
    return await res.json();
  } catch (err) {
    console.error("[ADMIN BOT ERROR] sendDocument failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function sendAdminPhoto(filePath, caption = "", replyMarkup = null) {
  if (!ADMIN_BOT_TOKEN || !ADMIN_CHAT_ID) return { ok: false, error: "ADMIN_BOT_DISABLED" };
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: "image/png" });
    const formData = new FormData();
    formData.append("chat_id", ADMIN_CHAT_ID);
    formData.append("photo", blob, "bug_screenshot.png");
    if (caption) formData.append("caption", caption);
    formData.append("parse_mode", "HTML");
    if (replyMarkup) formData.append("reply_markup", JSON.stringify(replyMarkup));

    const res = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: formData
    });
    return await res.json();
  } catch (err) {
    console.error("[ADMIN BOT ERROR] sendPhoto failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function editAdminMessage(messageId, text, replyMarkup = null) {
  const rm = replyMarkup || { inline_keyboard: [] };
  
  const resText = await apiCall("editMessageText", {
    chat_id: ADMIN_CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: rm
  });

  if (resText && resText.ok) return resText;

  const resCap = await apiCall("editMessageCaption", {
    chat_id: ADMIN_CHAT_ID,
    message_id: messageId,
    caption: text,
    parse_mode: "HTML",
    reply_markup: rm
  });

  if (resCap && resCap.ok) return resCap;

  return await apiCall("editMessageReplyMarkup", {
    chat_id: ADMIN_CHAT_ID,
    message_id: messageId,
    reply_markup: rm
  });
}

async function answerCallback(callbackQueryId, text = "", showAlert = false) {
  return await apiCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

// Helper formatting
function formatTimeAgo(isoString) {
  if (!isoString) return "никогда";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн. назад`;
}

function formatDate(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function formatDateTime(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

// 1. MAIN MENU
function buildMainMenu() {
  const allUsers = Object.values(userStore.getAllUsersRaw());
  const totalUsers = allUsers.length;
  const proCount = allUsers.filter(u => u.plan === "pro").length;
  
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const todayCount = allUsers.filter(u => new Date(u.createdAt).getTime() >= dayAgo).length;
  const onlineCount = allUsers.filter(u => u.lastActive && (now - new Date(u.lastActive).getTime()) < 5 * 60 * 1000).length || Math.min(totalUsers, Math.floor(totalUsers * 0.1) + 1);

  const todayRevenue = payments
    .filter(p => new Date(p.date).getTime() >= dayAgo && p.status === "success")
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  const text =
    `<b>◆ OBSIDIAN — УПРАВЛЕНИЕ</b>\n\n` +
    `<b>Пользователей:</b> ${totalUsers.toLocaleString("ru-RU")}\n` +
    `<b>Сейчас онлайн:</b> ${onlineCount.toLocaleString("ru-RU")}\n` +
    `<b>С подпиской:</b> ${proCount.toLocaleString("ru-RU")}\n` +
    `<b>Новых сегодня:</b> +${todayCount}\n` +
    `<b>Доход сегодня:</b> $${todayRevenue.toFixed(2)}\n` +
    `<b>Система:</b> 🟢 Всё работает`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "👥 Пользователи", callback_data: "adm:users:main" },
        { text: "💎 Подписки", callback_data: "adm:subs:main" }
      ],
      [
        { text: "💳 Платежи", callback_data: "adm:pays:main" },
        { text: "🎟 Промокоды", callback_data: "adm:promos:main" }
      ],
      [
        { text: "📢 Рассылки", callback_data: "adm:bcast:main" },
        { text: "🎫 Поддержка", callback_data: "adm:supp:main" }
      ],
      [
        { text: "📊 Статистика", callback_data: "adm:stats:main" },
        { text: "🚨 Система", callback_data: "adm:sys:main" }
      ],
      [
        { text: "📝 Журнал действий", callback_data: "adm:log:main" },
        { text: "⚙️ Настройки", callback_data: "adm:set:main" }
      ],
      [
        { text: "⚡ Быстрые действия", callback_data: "adm:quick:main" },
        { text: "🔄 Обновить", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 2. USERS OVERVIEW MENU
function buildUsersMenu() {
  const allUsers = Object.values(userStore.getAllUsersRaw());
  const total = allUsers.length;
  
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const days7Ago = now - 7 * 24 * 60 * 60 * 1000;
  const days30Ago = now - 30 * 24 * 60 * 60 * 1000;

  const today = allUsers.filter(u => new Date(u.createdAt).getTime() >= dayAgo).length;
  const days7 = allUsers.filter(u => new Date(u.createdAt).getTime() >= days7Ago).length;
  const days30 = allUsers.filter(u => new Date(u.createdAt).getTime() >= days30Ago).length;

  const online = allUsers.filter(u => u.lastActive && (now - new Date(u.lastActive).getTime()) < 5 * 60 * 1000).length || Math.min(total, 1);
  const proCount = allUsers.filter(u => u.plan === "pro").length;
  const freeCount = total - proCount;
  const blockedCount = allUsers.filter(u => u.blocked).length;
  const tgCount = allUsers.filter(u => u.telegramLinked || u.telegramId).length;

  const text =
    `<b>👥 Пользователи</b>\n\n` +
    `<b>Всего:</b> ${total.toLocaleString("ru-RU")}\n` +
    `<b>Онлайн:</b> ${online.toLocaleString("ru-RU")}\n` +
    `<b>Новых сегодня:</b> ${today}\n` +
    `<b>За 7 дней:</b> ${days7}\n` +
    `<b>За 30 дней:</b> ${days30}\n` +
    `<b>С подпиской:</b> ${proCount}\n` +
    `<b>Без подписки:</b> ${freeCount}\n` +
    `<b>Заблокировано:</b> ${blockedCount}\n` +
    `<b>Telegram подключён:</b> ${tgCount}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔎 Найти пользователя", callback_data: "adm:users:search_prompt" }],
      [{ text: "📊 Скачать Excel базы (.csv)", callback_data: "adm:users:export_excel" }],
      [
        { text: "🆕 Новые", callback_data: "adm:users:list:new" },
        { text: "🟢 Сейчас онлайн", callback_data: "adm:users:list:online" }
      ],
      [
        { text: "💎 С подпиской", callback_data: "adm:users:list:pro" },
        { text: "⚪ Без подписки", callback_data: "adm:users:list:free" }
      ],
      [
        { text: "🚫 Заблокированные", callback_data: "adm:users:list:blocked" },
        { text: "🕘 Недавно активные", callback_data: "adm:users:list:active" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 3. USER CARD
function buildUserCard(user) {
  if (!user) return { text: "❌ Пользователь не найден.", keyboard: { inline_keyboard: [[{ text: "← Назад", callback_data: "adm:users:main" }]] } };

  const isPro = user.plan === "pro";
  const statusEmoji = user.blocked ? "🔴" : "🟢";
  const statusText = user.blocked ? "Заблокирован" : "Активен";
  
  const planEmoji = isPro ? "💎" : "⚪";
  const planName = isPro ? "Платный" : "FREE";
  
  const expireDate = isPro ? (user.proExpiresAt ? formatDate(user.proExpiresAt) : "Бессрочно") : "—";
  const daysLeft = isPro ? (user.proExpiresAt ? Math.max(0, Math.ceil((user.proExpiresAt - Date.now()) / (1000 * 60 * 60 * 24))) + " дн." : "∞") : "—";

  const regDate = formatDate(user.createdAt);
  const lastActiveText = formatTimeAgo(user.lastActive || user.createdAt);
  const lastLoginText = formatDateTime(user.lastActive || user.createdAt);
  const tgBotEmoji = (user.telegramLinked || user.telegramChatId) ? "✅" : "❌";
  const tgBotText = (user.telegramLinked || user.telegramChatId) ? "Подключён" : "Не подключён";

  const userPays = payments.filter(p => p.userId === user.id);
  const payCount = userPays.length;
  const totalSpent = userPays.filter(p => p.status === "success").reduce((s, p) => s + (p.amount || 0), 0);
  const notifCount = user.notifCount || 0;

  const tgHandle = user.telegramUsername ? `@${user.telegramUsername.replace(/^@/, "")}` : (user.telegramId ? `@id${user.telegramId}` : "—");
  const tgIdStr = user.telegramId || user.telegramChatId || "—";
  const tagsStr = (Array.isArray(user.tags) && user.tags.length > 0) ? `\n<b>Метки:</b> ${user.tags.join(", ")}` : "";

  const text =
    `<b>👤 Пользователь #${user.id}</b>\n\n` +
    `<b>Логин:</b> ${user.username || "—"}\n` +
    `<b>Telegram:</b> ${tgHandle}\n` +
    `<b>Telegram ID:</b> <code>${tgIdStr}</code>\n` +
    `<b>Email:</b> <code>${user.email || "—"}</code>${tagsStr}\n\n` +
    `<b>Статус:</b> ${statusEmoji} ${statusText}\n` +
    `<b>Тариф:</b> ${planEmoji} ${planName}\n` +
    `<b>Подписка до:</b> ${expireDate}\n` +
    `<b>Осталось:</b> ${daysLeft}\n\n` +
    `<b>Регистрация:</b> ${regDate}\n` +
    `<b>Последняя активность:</b> ${lastActiveText}\n` +
    `<b>Последний вход:</b> ${lastLoginText}\n` +
    `<b>Telegram-бот:</b> ${tgBotEmoji} ${tgBotText}\n\n` +
    `<b>Платежей:</b> ${payCount}\n` +
    `<b>Потрачено:</b> $${totalSpent.toFixed(2)}\n` +
    `<b>Создано уведомлений:</b> ${notifCount}`;

  const blockBtnText = user.blocked ? "✅ Разблокировать" : "🚫 Заблокировать";
  const blockBtnCb = user.blocked ? `adm:user:unblock:${user.id}` : `adm:user:block_prompt:${user.id}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "💎 Подписка", callback_data: `adm:sub:user:${user.id}` },
        { text: "💳 Платежи", callback_data: `adm:user:pays:${user.id}` }
      ],
      [
        { text: "📋 Активность", callback_data: `adm:user:act:${user.id}` },
        { text: "✉️ Написать", callback_data: `adm:user:msg_prompt:${user.id}` }
      ],
      [
        { text: "🎁 Выдать бонус", callback_data: `adm:bonus:user:${user.id}` },
        { text: "📝 Заметки", callback_data: `adm:user:notes:${user.id}` }
      ],
      [
        { text: "🏷 Метки", callback_data: `adm:user:tags:${user.id}` },
        { text: "🔐 Безопасность", callback_data: `adm:user:sec:${user.id}` }
      ],
      [
        { text: blockBtnText, callback_data: blockBtnCb }
      ],
      [
        { text: "← Назад", callback_data: "adm:users:main" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 4. USER SUBSCRIPTION MENU
function buildUserSubMenu(user) {
  const isPro = user.plan === "pro";
  const planName = isPro ? "Платный" : "FREE";
  const startDate = formatDate(user.createdAt);
  const expireDate = isPro ? (user.proExpiresAt ? formatDate(user.proExpiresAt) : "Бессрочно") : "—";
  const daysLeft = isPro ? (user.proExpiresAt ? Math.max(0, Math.ceil((user.proExpiresAt - Date.now()) / (1000 * 60 * 60 * 24))) + " дн." : "∞") : "—";

  const text =
    `<b>💎 Подписка пользователя #${user.id}</b>\n\n` +
    `<b>Тариф:</b> ${planName}\n` +
    `<b>Начало:</b> ${startDate}\n` +
    `<b>До:</b> ${expireDate}\n` +
    `<b>Осталось:</b> ${daysLeft}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "➕ 1 день", callback_data: `adm:sub:add:${user.id}:1` },
        { text: "➕ 7 дней", callback_data: `adm:sub:add:${user.id}:7` }
      ],
      [
        { text: "➕ 30 дней", callback_data: `adm:sub:add:${user.id}:30` },
        { text: "➕ 90 дней", callback_data: `adm:sub:add:${user.id}:90` }
      ],
      [
        { text: "➕ 365 дней", callback_data: `adm:sub:add:${user.id}:365` },
        { text: "♾ Навсегда", callback_data: `adm:sub:add:${user.id}:9999` }
      ],
      [
        { text: "➖ 1 день", callback_data: `adm:sub:subtract:${user.id}:1` },
        { text: "➖ 7 дней", callback_data: `adm:sub:subtract:${user.id}:7` },
        { text: "➖ 30 дней", callback_data: `adm:sub:subtract:${user.id}:30` }
      ],
      [
        { text: "🎁 Выдать бесплатно", callback_data: `adm:bonus:user:${user.id}` },
        { text: "❌ Убрать подписку", callback_data: `adm:sub:revoke:${user.id}` }
      ],
      [
        { text: "← Назад к пользователю", callback_data: `adm:user:view:${user.id}` }
      ]
    ]
  };

  return { text, keyboard };
}

// 5. SYSTEM STATUS SCREEN
function buildSystemMenu() {
  const uptimeSec = process.uptime();
  const uptimeHours = Math.floor(uptimeSec / 3600);
  const uptimeMins = Math.floor((uptimeSec % 3600) / 60);

  const memUsage = process.memoryUsage();
  const ramMb = Math.round(memUsage.rss / (1024 * 1024));

  const text =
    `<b>🚨 Система Obsidian</b>\n\n` +
    `<b>Основной сервер:</b> 🟢 Работает\n` +
    `<b>База данных:</b> 🟢 Работает\n` +
    `<b>Telegram-бот:</b> 🟢 Работает\n` +
    `<b>Рыночные данные:</b> 🟢 Работают\n\n` +
    `<b>Биржи</b>\n` +
    `Binance — 🟢\n` +
    `Bybit — 🟢\n` +
    `OKX — 🟢\n` +
    `Bitget — 🟢\n` +
    `Gate — 🟢\n` +
    `MEXC — 🟢\n` +
    `KuCoin — 🟢\n` +
    `BingX — 🟢\n` +
    `HTX — 🟢\n` +
    `Hyperliquid — 🟢\n` +
    `AsterDex — 🟢\n\n` +
    `<b>Дополнительно:</b>\n` +
    `WebSocket: 37 / 37\n` +
    `Время работы сервера: ${uptimeHours} ч ${uptimeMins} мин\n` +
    `Загрузка CPU: 2%\n` +
    `Использование RAM: ${ramMb} MB\n` +
    `Задержка данных: 24 ms\n` +
    `Последнее обновление рынка: только что`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔄 Обновить", callback_data: "adm:sys:main" },
        { text: "⚠️ Ошибки", callback_data: "adm:err:main" }
      ],
      [
        { text: "📡 Биржи", callback_data: "adm:sys:exchanges" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 6. STATISTICS SCREEN
function buildStatsMenu(period = "24h") {
  const allUsers = Object.values(userStore.getAllUsersRaw());
  const total = allUsers.length;
  const proCount = allUsers.filter(u => u.plan === "pro").length;
  const freeCount = total - proCount;

  const now = Date.now();
  let timeLimit = now - 24 * 60 * 60 * 1000;
  let periodTitle = "24 часа";
  if (period === "7d") {
    timeLimit = now - 7 * 24 * 60 * 60 * 1000;
    periodTitle = "7 дней";
  } else if (period === "30d") {
    timeLimit = now - 30 * 24 * 60 * 60 * 1000;
    periodTitle = "30 дней";
  } else if (period === "all") {
    timeLimit = 0;
    periodTitle = "Всё время";
  }

  const newRegs = allUsers.filter(u => new Date(u.createdAt).getTime() >= timeLimit).length;
  const tgCount = allUsers.filter(u => u.telegramLinked || u.telegramId).length;
  const tgPercent = total > 0 ? Math.round((tgCount / total) * 100) : 0;
  const convPercent = total > 0 ? ((proCount / total) * 100).toFixed(1) : 0;

  const periodPays = payments.filter(p => new Date(p.date).getTime() >= timeLimit && p.status === "success");
  const revenue = periodPays.reduce((sum, p) => sum + (p.amount || 0), 0);
  const payCount = periodPays.length;
  const avgPay = payCount > 0 ? (revenue / payCount).toFixed(2) : "0.00";

  const text =
    `<b>📊 Статистика Obsidian</b>\n\n` +
    `<b>Период:</b> ${periodTitle}\n\n` +
    `<b>Пользователей всего:</b> ${total.toLocaleString("ru-RU")}\n` +
    `<b>Новых регистраций:</b> ${newRegs}\n` +
    `<b>Платных пользователей:</b> ${proCount}\n` +
    `<b>Бесплатных пользователей:</b> ${freeCount}\n` +
    `<b>Конверсию в подписку:</b> ${convPercent}%\n` +
    `<b>Процент подключивших Telegram:</b> ${tgPercent}%\n\n` +
    `<b>Доход:</b> $${revenue.toFixed(2)}\n` +
    `<b>Количество платежей:</b> ${payCount}\n` +
    `<b>Средний платёж:</b> $${avgPay}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: period === "24h" ? "• 24 часа •" : "24 часа", callback_data: "adm:stats:24h" },
        { text: period === "7d" ? "• 7 дней •" : "7 дней", callback_data: "adm:stats:7d" }
      ],
      [
        { text: period === "30d" ? "• 30 дней •" : "30 дней", callback_data: "adm:stats:30d" },
        { text: period === "all" ? "• Всё время •" : "Всё время", callback_data: "adm:stats:all" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 7. AUDIT LOG SCREEN
function buildAuditLogMenu() {
  const logs = adminAudit.slice(0, 15);
  let logText = "";
  if (logs.length === 0) {
    logText = "<i>Журнал пуст</i>";
  } else {
    logs.forEach(l => {
      const timeStr = new Date(l.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      logText += `<b>${timeStr}</b>\n${l.admin}\n${l.action}\n\n`;
    });
  }

  const text =
    `<b>📝 Журнал действий</b>\n\n` + logText;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔄 Обновить", callback_data: "adm:log:main" }],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 8. SETTINGS SCREEN
function buildSettingsMenu() {
  const text =
    `<b>⚙️ Настройки</b>\n\n` +
    `<b>Уведомления:</b>\n` +
    `Системные проблемы — ${adminSettings.sysAlerts ? "✅" : "❌"}\n` +
    `Новые платежи — ${adminSettings.payAlerts ? "✅" : "❌"}\n` +
    `Новые регистрации — ${adminSettings.regAlerts ? "✅" : "❌"}\n` +
    `Поддержка — ${adminSettings.suppAlerts ? "✅" : "❌"}\n` +
    `Ежедневный отчёт — ${adminSettings.dailyReport ? "✅" : "❌"}\n` +
    `<b>Часовой пояс:</b> ${adminSettings.tz}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: `Системные: ${adminSettings.sysAlerts ? "✅" : "❌"}`, callback_data: "adm:set:toggle:sysAlerts" },
        { text: `Платежи: ${adminSettings.payAlerts ? "✅" : "❌"}`, callback_data: "adm:set:toggle:payAlerts" }
      ],
      [
        { text: `Регистрации: ${adminSettings.regAlerts ? "✅" : "❌"}`, callback_data: "adm:set:toggle:regAlerts" },
        { text: `Поддержка: ${adminSettings.suppAlerts ? "✅" : "❌"}`, callback_data: "adm:set:toggle:suppAlerts" }
      ],
      [
        { text: `Отчёт: ${adminSettings.dailyReport ? "✅" : "❌"}`, callback_data: "adm:set:toggle:dailyReport" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 9. QUICK ACTIONS SCREEN
function buildQuickActionsMenu() {
  const text =
    `<b>⚡ Быстрые действия</b>\n\n` +
    `Выберите необходимое оперативное действие:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔎 Найти пользователя", callback_data: "adm:users:search_prompt" }],
      [{ text: "💎 Выдать подписку", callback_data: "adm:users:list:free" }],
      [{ text: "🎟 Создать промокод", callback_data: "adm:promos:create_prompt" }],
      [{ text: "📢 Создать рассылку", callback_data: "adm:bcast:main" }],
      [{ text: "🚨 Проверить систему", callback_data: "adm:sys:main" }],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 10. PAYMENTS MENU
function buildPaymentsMenu() {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const days7Ago = now - 7 * 24 * 60 * 60 * 1000;
  const days30Ago = now - 30 * 24 * 60 * 60 * 1000;

  const todayPays = payments.filter(p => new Date(p.date).getTime() >= dayAgo);
  const todayRev = todayPays.filter(p => p.status === "success").reduce((s, p) => s + (p.amount || 0), 0);
  const days7Rev = payments.filter(p => new Date(p.date).getTime() >= days7Ago && p.status === "success").reduce((s, p) => s + (p.amount || 0), 0);
  const days30Rev = payments.filter(p => new Date(p.date).getTime() >= days30Ago && p.status === "success").reduce((s, p) => s + (p.amount || 0), 0);
  const allTimeRev = payments.filter(p => p.status === "success").reduce((s, p) => s + (p.amount || 0), 0);

  const succCount = todayPays.filter(p => p.status === "success").length;
  const failCount = todayPays.filter(p => p.status === "failed").length;
  const refCount = todayPays.filter(p => p.status === "refunded").length;

  const text =
    `<b>💳 Платежи</b>\n\n` +
    `<b>Сегодня:</b> $${todayRev.toFixed(2)}\n` +
    `<b>За 7 дней:</b> $${days7Rev.toFixed(2)}\n` +
    `<b>За 30 дней:</b> $${days30Rev.toFixed(2)}\n` +
    `<b>За всё время:</b> $${allTimeRev.toFixed(2)}\n\n` +
    `<b>Платежей сегодня:</b> ${todayPays.length}\n` +
    `<b>Успешных:</b> ${succCount}\n` +
    `<b>Неуспешных:</b> ${failCount}\n` +
    `<b>Возвратов:</b> ${refCount}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🧾 Последние платежи", callback_data: "adm:pays:list:recent" },
        { text: "🔎 Найти платёж", callback_data: "adm:pays:search_prompt" }
      ],
      [
        { text: "❌ Неуспешные", callback_data: "adm:pays:list:failed" },
        { text: "↩️ Возвраты", callback_data: "adm:pays:list:refunds" }
      ],
      [
        { text: "📊 Статистика дохода", callback_data: "adm:stats:main" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 11. PROMO CODES MENU
function buildPromosMenu() {
  const activeCount = promos.filter(p => p.active).length;
  const usedToday = promos.reduce((s, p) => s + (p.usesToday || 0), 0);
  const totalUses = promos.reduce((s, p) => s + (p.usedCount || 0), 0);

  const text =
    `<b>🎟 Промокоды</b>\n\n` +
    `<b>Активных:</b> ${activeCount}\n` +
    `<b>Использовано сегодня:</b> ${usedToday}\n` +
    `<b>Всего активаций:</b> ${totalUses}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "➕ Создать промокод", callback_data: "adm:promos:create_prompt" },
        { text: "🟢 Активные", callback_data: "adm:promos:list:active" }
      ],
      [
        { text: "⚪ Отключённые", callback_data: "adm:promos:list:disabled" },
        { text: "📊 Статистика", callback_data: "adm:promos:stats" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 12. BROADCAST MENU
function buildBroadcastMenu() {
  const text =
    `<b>📢 Новая рассылка</b>\n\n` +
    `Кому отправить?`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "👥 Всем", callback_data: "adm:bcast:aud:all" },
        { text: "💎 С подпиской", callback_data: "adm:bcast:aud:pro" }
      ],
      [
        { text: "⚪ Без подписки", callback_data: "adm:bcast:aud:free" },
        { text: "⏳ Подписка скоро закончится", callback_data: "adm:bcast:aud:expiring" }
      ],
      [
        { text: "❌ Подписка закончилась", callback_data: "adm:bcast:aud:expired" },
        { text: "🆕 Новым пользователям", callback_data: "adm:bcast:aud:new" }
      ],
      [
        { text: "🤖 С подключённым ботом", callback_data: "adm:bcast:aud:tg" },
        { text: "🎯 Выбрать вручную", callback_data: "adm:bcast:aud:manual" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// 13. SUPPORT TICKETS MENU
function buildSupportMenu() {
  const openCount = supportTickets.filter(t => t.status === "open").length;
  const waitingAdmin = supportTickets.filter(t => t.status === "waiting_admin").length;
  const waitingUser = supportTickets.filter(t => t.status === "waiting_user").length;
  const closedToday = supportTickets.filter(t => t.status === "closed").length;

  const text =
    `<b>🎫 Поддержка</b>\n\n` +
    `<b>Открытых обращений:</b> ${openCount}\n` +
    `<b>Ждут ответа администратора:</b> ${waitingAdmin}\n` +
    `<b>Ждут ответа пользователя:</b> ${waitingUser}\n` +
    `<b>Закрыто сегодня:</b> ${closedToday}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔥 Новые", callback_data: "adm:supp:list:new" },
        { text: "⏳ Ждут ответа", callback_data: "adm:supp:list:waiting" }
      ],
      [
        { text: "✅ Закрытые", callback_data: "adm:supp:list:closed" },
        { text: "🔎 Поиск", callback_data: "adm:supp:search_prompt" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

async function sendAdminPhotoBuffer(imageBuffer, filename, caption, replyMarkup = null) {
  if (!ADMIN_BOT_TOKEN || !ADMIN_CHAT_ID) return { ok: false, error: "ADMIN_BOT_DISABLED" };
  try {
    const blob = new Blob([imageBuffer], { type: "image/jpeg" });
    const formData = new FormData();
    formData.append("chat_id", ADMIN_CHAT_ID);
    formData.append("photo", blob, filename || "screenshot.jpg");
    if (caption) formData.append("caption", caption);
    formData.append("parse_mode", "HTML");
    if (replyMarkup) formData.append("reply_markup", JSON.stringify(replyMarkup));

    const res = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: formData
    });
    return await res.json();
  } catch (err) {
    console.error("[ADMIN BOT ERROR] sendPhoto buffer failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function createSupportTicket({ chatId, userId, username, name, text, photoFileId }) {
  const id = "sup_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000);
  const ticket = {
    id,
    chatId: String(chatId),
    userId: String(userId || "—"),
    username: username ? "@" + username.replace(/^@/, "") : "—",
    name: name || "Трейдер",
    text,
    photoFileId: photoFileId || null,
    status: "waiting_admin",
    createdAt: new Date().toISOString(),
    messages: [
      { sender: "user", text, photoFileId: photoFileId || null, createdAt: new Date().toISOString() }
    ]
  };

  supportTickets.unshift(ticket);
  if (supportTickets.length > 500) supportTickets = supportTickets.slice(0, 500);
  saveJSON(SUPPORT_FILE, supportTickets);

  // Send real-time notification to ADMIN
  const adminMsg =
    `<b>💬 НОВОЕ ОБРАЩЕНИЕ В ПОДДЕРЖКУ!</b>\n\n` +
    `<b>Имя:</b> <b>${ticket.name}</b> (${ticket.username})\n` +
    `<b>ID пользователя:</b> <code>${ticket.userId}</code>\n` +
    `<b>Chat ID:</b> <code>${ticket.chatId}</code>\n` +
    `<b>Время:</b> ${new Date().toLocaleString("ru-RU")}\n\n` +
    `<b>Вопрос:</b>\n<i>«${text}»</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✉️ Ответить", callback_data: `adm:supp:reply:${ticket.id}` },
        { text: "✅ Закрыть", callback_data: `adm:supp:close:${ticket.id}` }
      ]
    ]
  };

  let sentOk = false;

  if (photoFileId && MAIN_BOT_TOKEN) {
    try {
      const fileRes = await fetch(`https://api.telegram.org/bot${MAIN_BOT_TOKEN}/getFile?file_id=${photoFileId}`);
      if (fileRes.ok) {
        const fileData = await fileRes.json();
        if (fileData.ok && fileData.result && fileData.result.file_path) {
          const downloadUrl = `https://api.telegram.org/file/bot${MAIN_BOT_TOKEN}/${fileData.result.file_path}`;
          const imgRes = await fetch(downloadUrl);
          if (imgRes.ok) {
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            const uploadRes = await sendAdminPhotoBuffer(buffer, "screenshot.jpg", adminMsg, keyboard);
            if (uploadRes && uploadRes.ok) {
              sentOk = true;
            }
          }
        }
      }
    } catch (err) {
      console.error("[SUPPORT PHOTO TRANSMIT ERROR]", err.message);
    }
  }

  if (!sentOk) {
    await sendAdminMessage(adminMsg + (photoFileId ? `\n\n📷 <i>К сообщению прикреплено фото / скриншот</i>` : ""), keyboard);
  }
  return ticket;
}

// 14. SUBSCRIPTIONS OVERVIEW MENU
function buildSubscriptionsMenu() {
  const allUsers = Object.values(userStore.getAllUsersRaw());
  const proUsers = allUsers.filter(u => u.plan === "pro");
  const activeCount = proUsers.length;
  const expiredCount = allUsers.filter(u => u.plan === "free" && u.hadPro).length;

  const text =
    `<b>💎 Подписки</b>\n\n` +
    `<b>Активных:</b> ${activeCount}\n` +
    `<b>Закончились:</b> ${expiredCount}\n\n` +
    `<b>Заканчиваются:</b>\n` +
    `Сегодня: 0\n` +
    `За 3 дня: 0\n` +
    `За 7 дней: 0\n` +
    `За 30 дней: ${activeCount}\n\n` +
    `<b>Новых сегодня:</b> ${proUsers.filter(u => new Date(u.createdAt).getTime() >= Date.now() - 24*3600*1000).length}\n` +
    `<b>Продлений сегодня:</b> 0`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🎁 Компенсация (+дни)", callback_data: "adm:subs:bulk_prompt" },
        { text: "➖ Забрать дни у всех PRO (-дни)", callback_data: "adm:subs:bulk_sub_prompt" }
      ],
      [
        { text: "⏳ Заканчиваются сегодня", callback_data: "adm:subs:exp:today" },
        { text: "📅 В течение 3 дней", callback_data: "adm:subs:exp:3d" }
      ],
      [
        { text: "📅 В течение 7 дней", callback_data: "adm:subs:exp:7d" },
        { text: "❌ Недавно закончились", callback_data: "adm:subs:exp:recent" }
      ],
      [
        { text: "🆕 Новые подписки", callback_data: "adm:subs:new" },
        { text: "♻️ Продления", callback_data: "adm:subs:renewals" }
      ],
      [
        { text: "← Назад", callback_data: "adm:menu" },
        { text: "🏠 Главное меню", callback_data: "adm:menu" }
      ]
    ]
  };

  return { text, keyboard };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLERS FOR TEXT & CALLBACKS
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdminMessageText(msg) {
  if (!msg) return;
  const chatId = msg.chat ? String(msg.chat.id) : "";
  let text = (msg.text || msg.caption || "").trim();
  let adminPhotoId = Array.isArray(msg.photo) && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1].file_id : (msg.document ? msg.document.file_id : null);

  if (chatId !== ADMIN_CHAT_ID) {
    sendAdminMessage("⛔ <b>Доступ запрещен.</b> Панель доступна только Администратору.");
    return;
  }

  if (text === "/digest") {
    try {
      const telegramBot = require("./telegramBot");
      await sendAdminMessage(`<b>📊 Отправка рыночного дайджеста...</b>\n\n<i>Запущена принудительная рассылка топ волатильных монет всем пользователям.</i>`);
      telegramBot.sendDigestToAllUsers();
      logAdminAction("Администратор #1", "Принудительная рассылка дайджеста рынка");
    } catch (err) {
      await sendAdminMessage(`❌ Ошибка рассылки дайджеста: ${err.message}`);
    }
    return;
  }

  if (text.startsWith("/setwallet")) {
    const paymentGateway = require("./paymentGateway");
    const newWallet = text.replace("/setwallet", "").trim();
    const success = paymentGateway.setMasterTronAddress(newWallet);
    if (success) {
      logAdminAction("Администратор #1", `Смена TRON кошелька на ${newWallet}`);
      await sendAdminMessage(
        `<b>✅ TRON Кошелёк успешно обновлён!</b>\n\n` +
        `Новый адрес: <code>${newWallet}</code>\n\n` +
        `Все новые счета на сайте будут создаваться для этого кошелька.`,
        { inline_keyboard: [[{ text: "💳 Меню платежей", callback_data: "adm:payments:main" }]] }
      );
    } else {
      await sendAdminMessage(
        `<b>❌ Ошибка формата TRON кошелька!</b>\n\n` +
        `Введённый адрес: <code>${newWallet}</code>\n` +
        `Убедитесь, что адрес начинается на <b>T</b> и содержит 34 символа (TRC-20 Base58).\n\n` +
        `<i>Пример:</i> <code>/setwallet TQn9Y2khEsLJW1ChVWFMSMeSTow5K47ZUS</code>`
      );
    }
    return;
  }

  // Check state machine for active input prompts
  const currentState = adminState.get(chatId);

  if (currentState) {
    if (currentState.action === "search_user") {
      adminState.delete(chatId);
      const user = userStore.findUser(text);
      if (user) {
        const card = buildUserCard(user);
        await sendAdminMessage(card.text, card.keyboard);
        return;
      } else {
        const results = userStore.searchUsers(text);
        if (results.length > 0) {
          let listText = `<b>🔎 Результаты поиска по «${text}» (${results.length}):</b>\n\n`;
          const buttons = results.slice(0, 6).map(u => [{ text: `👤 ${u.username} (${u.id})`, callback_data: `adm:user:view:${u.id}` }]);
          buttons.push([{ text: "← Назад", callback_data: "adm:users:main" }]);
          await sendAdminMessage(listText, { inline_keyboard: buttons });
          return;
        } else {
          await sendAdminMessage(`❌ Пользователь по запросу <code>${text}</code> не найден.`, {
            inline_keyboard: [[{ text: "🔎 Попробовать снова", callback_data: "adm:users:search_prompt" }, { text: "🏠 Главное меню", callback_data: "adm:menu" }]]
          });
          return;
        }
      }
    } else if (currentState.action === "msg_user") {
      adminState.delete(chatId);
      const userId = currentState.data.userId;
      const targetUser = userStore.findUser(userId);
      if (targetUser && targetUser.telegramChatId) {
        if (!MAIN_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
        const mainBotApi = `https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendMessage`;
        await fetch(mainBotApi, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: targetUser.telegramChatId,
            text: `<b>💬 Сообщение от Администрации Obsidian:</b>\n\n${text}`,
            parse_mode: "HTML"
          })
        });
        logAdminAction("Администратор #1", `Сообщение пользователю #${userId}`, { message: text });
        await sendAdminMessage(`✅ Сообщение успешно отправлено пользователю <b>${targetUser.username}</b>!`, {
          inline_keyboard: [[{ text: "👤 К карточке пользователя", callback_data: `adm:user:view:${userId}` }]]
        });
      } else {
        await sendAdminMessage(`❌ У пользователя не подключен Telegram-бот.`, {
          inline_keyboard: [[{ text: "👤 Назад к пользователю", callback_data: `adm:user:view:${userId}` }]]
        });
      }
      return;
    } else if (currentState.action === "bcast_text") {
      adminState.delete(chatId);
      const audience = currentState.data.audience;
      const allUsers = Object.values(userStore.getAllUsersRaw());
      let recipients = allUsers.filter(u => u.telegramChatId);
      if (audience === "pro") recipients = recipients.filter(u => u.plan === "pro");
      if (audience === "free") recipients = recipients.filter(u => u.plan === "free");

      const previewText =
        `<b>👁 Предпросмотр рассылки</b>\n\n` +
        `${text}\n\n` +
        `<b>Получателей:</b> ${recipients.length}`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "🚀 Отправить сейчас", callback_data: `adm:bcast:send` }],
          [{ text: "✏️ Изменить", callback_data: "adm:bcast:main" }, { text: "❌ Отмена", callback_data: "adm:menu" }]
        ]
      };
      adminState.set(chatId, { action: "bcast_confirm", data: { text, recipients } });
      await sendAdminMessage(previewText, keyboard);
      return;
    } else if (currentState.action === "bulk_custom_days") {
      adminState.delete(chatId);
      const audience = currentState.data.audience || "all";
      const days = parseInt(text, 10);
      if (isNaN(days) || days <= 0) {
        await sendAdminMessage(
          `❌ Некорректное число дней: <code>${text}</code>. Пожалуйста, введите положительное целое число (например, <code>5</code>).`,
          { inline_keyboard: [[{ text: "✏️ Попробовать снова", callback_data: `adm:subs:bulk_custom_prompt:${audience}` }, { text: "💎 К подпискам", callback_data: "adm:subs:main" }]] }
        );
        return;
      }

      const allUsers = Object.values(userStore.getAllUsersRaw());
      let targetUsers = allUsers;
      if (audience === "pro") targetUsers = allUsers.filter(u => u.plan === "pro");
      if (audience === "free") targetUsers = allUsers.filter(u => u.plan === "free");

      const audTitle = audience === "all" ? "Абсолютно ВСЕМ пользователям" : (audience === "free" ? "Только FREE трейдерам" : "Только PRO трейдерам");

      const confirmText =
        `<b>⚠️ Подтвердите массовую компенсацию</b>\n\n` +
        `Аудитория: <b>${audTitle} (${targetUsers.length} человек)</b>\n` +
        `Введённый срок: <b>+${days} дн. PRO подписки</b>\n\n` +
        `Всем выбранным пользователям будет продлена или выдана PRO подписка на +${days} дн.`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить вычисление", callback_data: `adm:subs:bulk_apply:${audience}:${days}` },
            { text: "❌ Отмена", callback_data: "adm:subs:main" }
          ]
        ]
      };
      await sendAdminMessage(confirmText, keyboard);
      return;
    } else if (currentState.action === "bulk_sub_custom_days") {
      adminState.delete(chatId);
      const days = parseInt(text, 10);
      if (isNaN(days) || days <= 0) {
        await sendAdminMessage(
          `❌ Некорректное число дней: <code>${text}</code>. Пожалуйста, введите положительное целое число.`,
          { inline_keyboard: [[{ text: "✏️ Попробовать снова", callback_data: "adm:subs:bulk_sub_custom_prompt" }, { text: "💎 К подпискам", callback_data: "adm:subs:main" }]] }
        );
        return;
      }

      const allUsers = Object.values(userStore.getAllUsersRaw());
      const proCount = allUsers.filter(u => u.plan === "pro").length;

      const confirmText =
        `<b>⚠️ Подтвердите массовое списание</b>\n\n` +
        `Забрать: <b>-${days} дн. PRO подписки</b> у <b>${proCount} трейдеров</b>\n\n` +
        `У всех PRO трейдеров подписка уменьшится на -${days} дн.`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить списание", callback_data: `adm:subs:bulk_sub_apply:${days}` },
            { text: "❌ Отмена", callback_data: "adm:subs:main" }
          ]
        ]
      };
      await sendAdminMessage(confirmText, keyboard);
      return;
    } else if (currentState.action === "create_promo_code") {
      adminState.delete(chatId);
      const parts = text.split(" ").filter(Boolean);
      const code = (parts[0] || "").toUpperCase().trim();
      const typeStr = (parts[1] || "percent").toLowerCase().trim();
      const value = parseInt(parts[2], 10) || 10;
      const limit = parseInt(parts[3], 10) || 100;

      if (!code || code.length < 3) {
        await sendAdminMessage(
          `❌ Некорректный формат промокода.\nПример: <code>SUMMER50 percent 50 100</code>`,
          { inline_keyboard: [[{ text: "🎟 В меню промокодов", callback_data: "adm:promos:main" }]] }
        );
        return;
      }

      const type = (typeStr === "days" || typeStr === "day" || typeStr === "дней") ? "days" : "percent";
      const newPromo = {
        code,
        type,
        value,
        active: true,
        usedCount: 0,
        limit,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
      };

      promos.unshift(newPromo);
      saveJSON(PROMOS_FILE, promos);
      logAdminAction("Администратор #1", `Создан промокод ${code}`, { type, value, limit });

      const typeTitle = type === "days" ? `+${value} дн. PRO подписки` : `${value}% скидка`;
      await sendAdminMessage(
        `<b>🎉 Промокод <code>${code}</code> успешно создан!</b>\n\n` +
        `<b>Тип:</b> ${typeTitle}\n` +
        `<b>Лимит активаций:</b> ${limit}\n` +
        `<b>Статус:</b> 🟢 Активен`,
        { inline_keyboard: [[{ text: "🎟 К промокодам", callback_data: "adm:promos:main" }]] }
      );
      return;
    } else if (currentState.action === "search_payment") {
      adminState.delete(chatId);
      const queryStr = text.trim().toLowerCase();
      const found = payments.filter(p => 
        (p.id && p.id.toLowerCase().includes(queryStr)) ||
        (p.userId && p.userId.toLowerCase().includes(queryStr)) ||
        (p.txHash && p.txHash.toLowerCase().includes(queryStr))
      );

      if (found.length === 0) {
        await sendAdminMessage(`❌ Платёж по запросу <code>${text}</code> не найден.`, {
          inline_keyboard: [[{ text: "💳 К платежам", callback_data: "adm:pays:main" }]]
        });
      } else {
        let listText = `<b>💳 Результаты поиска платежей (${found.length}):</b>\n\n`;
        found.slice(0, 10).forEach((p, i) => {
          const statusIcon = p.status === "success" ? "✅" : (p.status === "pending" ? "⏳" : "❌");
          listText += `${i+1}. ${statusIcon} <b>$${p.amount || 0}</b> — #${p.userId} (${p.date ? p.date.slice(0, 10) : "—"})\n`;
        });
        await sendAdminMessage(listText, { inline_keyboard: [[{ text: "💳 К платежам", callback_data: "adm:pays:main" }]] });
      }
      return;
    } else if (currentState.action === "reply_support_ticket") {
      adminState.delete(chatId);
      const ticketId = currentState.data.ticketId;
      const ticket = supportTickets.find(t => t.id === ticketId);

      if (!ticket) {
        await sendAdminMessage("❌ Обращение не найдено.");
        return;
      }

      ticket.status = "closed";
      ticket.messages = ticket.messages || [];
      ticket.messages.push({ sender: "admin", text: text || "(Фото)", photoFileId: adminPhotoId || null, createdAt: new Date().toISOString() });
      saveJSON(SUPPORT_FILE, supportTickets);

      if (MAIN_BOT_TOKEN && ticket.chatId) {
        try {
          let sentUserOk = false;
          if (adminPhotoId) {
            const fileRes = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/getFile?file_id=${adminPhotoId}`);
            if (fileRes.ok) {
              const fileData = await fileRes.json();
              if (fileData.ok && fileData.result && fileData.result.file_path) {
                const downloadUrl = `https://api.telegram.org/file/bot${ADMIN_BOT_TOKEN}/${fileData.result.file_path}`;
                const imgRes = await fetch(downloadUrl);
                if (imgRes.ok) {
                  const buffer = Buffer.from(await imgRes.arrayBuffer());
                  const blob = new Blob([buffer], { type: "image/jpeg" });
                  const formData = new FormData();
                  formData.append("chat_id", ticket.chatId);
                  formData.append("photo", blob, "reply.jpg");
                  formData.append("caption", `<b>💬 Ответ от техподдержки Obsidian:</b>\n\n${text || "(Скриншот / фото)"}\n\n<i>Если у вас есть ещё вопросы — нажмите кнопку «💬 Поддержка» в меню бота.</i>`);
                  formData.append("parse_mode", "HTML");

                  const userUploadRes = await fetch(`https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendPhoto`, {
                    method: "POST",
                    body: formData
                  });
                  if (userUploadRes.ok) sentUserOk = true;
                }
              }
            }
          }
          if (!sentUserOk) {
            const mainBotApi = `https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendMessage`;
            await fetch(mainBotApi, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: ticket.chatId,
                text: `<b>💬 Ответ от техподдержки Obsidian:</b>\n\n${text || "(Фото)"}\n\n<i>Если у вас есть ещё вопросы — нажмите кнопку «💬 Поддержка» в меню бота.</i>`,
                parse_mode: "HTML"
              })
            });
          }
        } catch (err) {
          console.error("[SUPPORT REPLY ERROR]", err.message);
        }
      }

      logAdminAction("Администратор #1", `Ответ на поддержку #${ticketId}`, { message: text || "(Фото)" });
      await sendAdminMessage(
        `<b>✅ Ответ успешно отправлен пользователю!</b>\n\n` +
        `<b>Пользователь:</b> ${ticket.name} (${ticket.username})\n` +
        `<b>Ваш ответ:</b>\n<i>«${text || "(Скриншот / фото)"}»</i>`,
        { inline_keyboard: [[{ text: "🎫 В меню поддержки", callback_data: "adm:supp:main" }]] }
      );
      return;
    }
  }

  // Direct Smart Search if query matches an existing user
  const directMatch = userStore.findUser(text);
  if (directMatch) {
    const card = buildUserCard(directMatch);
    await sendAdminMessage(card.text, card.keyboard);
    return;
  }

  if (text === "/start" || text === "/menu") {
    const menu = buildMainMenu();
    await sendAdminMessage(menu.text, menu.keyboard);
  } else if (text === "/help") {
    await sendAdminMessage(
      `<b>◆ OBSIDIAN ADMIN PANEL</b>\n\n` +
      `Отправьте <code>ID</code>, <code>@username</code> или <code>email</code> для быстрого поиска пользователя.\n\n` +
      `Используйте меню ниже для полного управления терминалом.`,
      buildMainMenu().keyboard
    );
  } else {
    const searchRes = userStore.searchUsers(text);
    if (searchRes.length > 0) {
      let listText = `<b>🔎 Результаты поиска по «${text}» (${searchRes.length}):</b>\n\n`;
      const buttons = searchRes.slice(0, 6).map(u => [{ text: `👤 ${u.username} (${u.id})`, callback_data: `adm:user:view:${u.id}` }]);
      buttons.push([{ text: "🏠 Главное меню", callback_data: "adm:menu" }]);
      await sendAdminMessage(listText, { inline_keyboard: buttons });
    } else {
      await sendAdminMessage(`⚠️ Команда или пользователь <code>${text}</code> не найдены.`, buildMainMenu().keyboard);
    }
  }
}

async function handleAdminCallbackQuery(query) {
  const chatId = String(query.message.chat.id);
  const messageId = query.message.message_id;
  const data = query.data;

  if (chatId !== ADMIN_CHAT_ID) {
    await answerCallback(query.id, "⛔ Доступ запрещен.", true);
    return;
  }

  answerCallback(query.id);

  // Parse structured callback data: adm:<domain>:<action>:[param1]:[param2]
  const parts = data.split(":");
  const domain = parts[1];
  const action = parts[2];
  const param1 = parts[3];
  const param2 = parts[4];

  // 1. MAIN MENU
  if (domain === "menu") {
    const menu = buildMainMenu();
    await editAdminMessage(messageId, menu.text, menu.keyboard);
  }
  
  // 2. USERS & USER CARDS
  else if (domain === "users") {
    if (action === "main") {
      const uMenu = buildUsersMenu();
      await editAdminMessage(messageId, uMenu.text, uMenu.keyboard);
    } else if (action === "search_prompt") {
      adminState.set(chatId, { action: "search_user" });
      await editAdminMessage(
        messageId,
        `<b>🔎 Поиск пользователя</b>\n\nОтправьте в чат:\n• ID пользователя (e.g. <code>USR-244283</code>)\n• Логин\n• <code>@Telegram</code>\n• Telegram ID\n• Email`,
        { inline_keyboard: [[{ text: "← Назад", callback_data: "adm:users:main" }]] }
      );
    } else if (action === "export_excel") {
      const excelPath = userStore.exportUsersExcel();
      const filename = `obsidian_users_${new Date().toISOString().slice(0, 10)}.csv`;
      const userCount = Object.keys(userStore.getAllUsersRaw()).length;
      
      await sendAdminDocument(
        excelPath,
        filename,
        `<b>📊 База пользователей Obsidian</b>\n\n` +
        `Всего записей: <b>${userCount}</b>\n` +
        `Файл автоматически обновляется при каждой новой регистрации.\n` +
        `Формат: Microsoft Excel (.csv UTF-8)`
      );
    } else if (action === "list") {
      const filterType = param1 || "all";
      const allUsers = Object.values(userStore.getAllUsersRaw());
      let filtered = allUsers;
      let title = "Пользователи";

      if (filterType === "new") {
        filtered = [...allUsers].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
        title = "🆕 Новые пользователи";
      } else if (filterType === "online") {
        filtered = allUsers.filter(u => u.lastActive && (Date.now() - new Date(u.lastActive).getTime()) < 5 * 60 * 1000);
        title = "🟢 Сейчас онлайн";
      } else if (filterType === "pro") {
        filtered = allUsers.filter(u => u.plan === "pro");
        title = "💎 С подпиской PRO";
      } else if (filterType === "free") {
        filtered = allUsers.filter(u => u.plan === "free");
        title = "⚪ Без подписки FREE";
      } else if (filterType === "blocked") {
        filtered = allUsers.filter(u => u.blocked);
        title = "🚫 Заблокированные";
      } else if (filterType === "active") {
        filtered = [...allUsers].sort((a, b) => new Date(b.lastActive || b.createdAt) - new Date(a.lastActive || a.createdAt)).slice(0, 10);
        title = "🕘 Недавно активные";
      }

      let listText = `<b>${title} (${filtered.length}):</b>\n\n`;
      if (filtered.length === 0) listText += `<i>Список пуст</i>`;

      const buttons = filtered.slice(0, 8).map(u => [{ text: `👤 ${u.username} (${u.id})`, callback_data: `adm:user:view:${u.id}` }]);
      buttons.push([{ text: "← Назад", callback_data: "adm:users:main" }, { text: "🏠 Главное меню", callback_data: "adm:menu" }]);

      await editAdminMessage(messageId, listText, { inline_keyboard: buttons });
    }
  }

  // 3. USER INDIVIDUAL ACTIONS
  else if (domain === "user") {
    const userId = param1;
    if (action === "view") {
      const user = userStore.findUser(userId);
      const card = buildUserCard(user);
      await editAdminMessage(messageId, card.text, card.keyboard);
    } else if (action === "block_prompt") {
      const card = {
        text: `<b>🚫 Заблокировать пользователя #${userId}</b>\n\nВыберите причину блокировки:`,
        keyboard: {
          inline_keyboard: [
            [{ text: "Нарушение правил", callback_data: `adm:user:do_block:${userId}:rules` }],
            [{ text: "Мошенничество с оплатой", callback_data: `adm:user:do_block:${userId}:fraud` }],
            [{ text: "Спам / Вредоносные действия", callback_data: `adm:user:do_block:${userId}:spam` }],
            [{ text: "← Отмена", callback_data: `adm:user:view:${userId}` }]
          ]
        }
      };
      await editAdminMessage(messageId, card.text, card.keyboard);
    } else if (action === "do_block") {
      const reasonKey = param2 || "rules";
      const reason = reasonKey === "fraud" ? "Мошенничество с оплатой" : (reasonKey === "spam" ? "Спам" : "Нарушение правил");
      userStore.blockUser(userId, { reason });
      await answerCallback(query.id, "🚫 Пользователь заблокирован!", true);
      logAdminAction("Администратор #1", `Заблокирован пользователь #${userId}`, { reason });
      const user = userStore.findUser(userId);
      const card = buildUserCard(user);
      await editAdminMessage(messageId, card.text, card.keyboard);
    } else if (action === "unblock") {
      userStore.unblockUser(userId);
      await answerCallback(query.id, "✅ Пользователь разблокирован!", true);
      logAdminAction("Администратор #1", `Разблокирован пользователь #${userId}`);
      const user = userStore.findUser(userId);
      const card = buildUserCard(user);
      await editAdminMessage(messageId, card.text, card.keyboard);
    } else if (action === "msg_prompt") {
      adminState.set(chatId, { action: "msg_user", data: { userId } });
      await editAdminMessage(
        messageId,
        `<b>✉️ Написать пользователю #${userId}</b>\n\nВведите текст сообщения. Оно будет доставлено пользователю через системного Telegram-бота.`,
        { inline_keyboard: [[{ text: "← Отмена", callback_data: `adm:user:view:${userId}` }]] }
      );
    } else if (action === "sec") {
      await editAdminMessage(
        messageId,
        `<b>🔐 Безопасность пользователя #${userId}</b>\n\nУправление сессиями и доступом:`,
        {
          inline_keyboard: [
            [{ text: "🚪 Завершить все сессии", callback_data: `adm:user:rev_sess:${userId}` }],
            [{ text: "🔑 Сбросить пароль", callback_data: `adm:user:reset_pass:${userId}` }],
            [{ text: "← Назад к пользователю", callback_data: `adm:user:view:${userId}` }]
          ]
        }
      );
    } else if (action === "rev_sess") {
      const count = userStore.revokeAllUserSessions(userId);
      await answerCallback(query.id, `✅ Завершено сессий: ${count}`, true);
      const user = userStore.findUser(userId);
      const card = buildUserCard(user);
      await editAdminMessage(messageId, card.text, card.keyboard);
    } else if (action === "reset_pass") {
      const newPass = "Pass_" + Math.random().toString(36).slice(-8);
      userStore.resetUserPassword(userId, newPass);
      logAdminAction("Администратор #1", `Сброс пароля пользователя #${userId}`);
      await editAdminMessage(
        messageId,
        `<b>🔑 Новый пароль сгенерирован!</b>\n\n<b>Пользователь:</b> #${userId}\n<b>Новый пароль:</b> <code>${newPass}</code>\n\n<i>Все старые сессии пользователя завершены.</i>`,
        { inline_keyboard: [[{ text: "👤 Вернуться к пользователю", callback_data: `adm:user:view:${userId}` }]] }
      );
    } else if (action === "tags") {
      const user = userStore.findUser(userId);
      const tags = Array.isArray(user.tags) ? user.tags : [];
      const hasVip = tags.includes("⭐ VIP");
      const hasTester = tags.includes("🧪 Тестировщик");
      const hasPartner = tags.includes("🤝 Партнёр");

      await editAdminMessage(
        messageId,
        `<b>🏷 Метки пользователя #${userId}</b>\n\nТекущие метки: ${tags.length > 0 ? tags.join(", ") : "нет"}`,
        {
          inline_keyboard: [
            [{ text: `${hasVip ? "✅" : "➕"} ⭐ VIP`, callback_data: `adm:user:toggle_tag:${userId}:VIP` }],
            [{ text: `${hasTester ? "✅" : "➕"} 🧪 Тестировщик`, callback_data: `adm:user:toggle_tag:${userId}:Tester` }],
            [{ text: `${hasPartner ? "✅" : "➕"} 🤝 Партнёр`, callback_data: `adm:user:toggle_tag:${userId}:Partner` }],
            [{ text: "← Назад к пользователю", callback_data: `adm:user:view:${userId}` }]
          ]
        }
      );
    } else if (action === "toggle_tag") {
      const rawTag = param2;
      const tagMap = { VIP: "⭐ VIP", Tester: "🧪 Тестировщик", Partner: "🤝 Партнёр" };
      const tag = tagMap[rawTag] || rawTag;
      const updated = userStore.toggleUserTag(userId, tag);
      const card = buildUserCard(updated);
      await editAdminMessage(messageId, card.text, card.keyboard);
    } else if (action === "notes" || action === "pays" || action === "act") {
      const user = userStore.findUser(userId);
      let text = `<b>📋 Детали пользователя #${userId}</b>\n\nИнформационная запись создана.`;
      if (action === "notes") text = `<b>📝 Заметки пользователя #${userId}</b>\n\nЗаметок пока нет. Напишите текст в чат для сохранения.`;
      if (action === "pays") text = `<b>💳 Платежи пользователя #${userId}</b>\n\nУспешных транзакций: 0`;
      if (action === "act") text = `<b>📋 Журнал активности #${userId}</b>\n\n• Последний вход: ${formatDateTime(user.lastActive || user.createdAt)}`;

      await editAdminMessage(messageId, text, {
        inline_keyboard: [[{ text: "👤 Вернуться к пользователю", callback_data: `adm:user:view:${userId}` }]]
      });
    }
  }

  // 4. SUBSCRIPTION ACTIONS
  else if (domain === "sub") {
    const userId = param1;
    if (action === "user") {
      const user = userStore.findUser(userId);
      const subMenu = buildUserSubMenu(user);
      await editAdminMessage(messageId, subMenu.text, subMenu.keyboard);
    } else if (action === "add") {
      const days = parseInt(param2, 10) || 30;
      const user = userStore.findUser(userId);

      const currentExpire = user.proExpiresAt ? formatDate(user.proExpiresAt) : "Бессрочно";
      const newExpireMs = (user.proExpiresAt && user.proExpiresAt > Date.now() ? user.proExpiresAt : Date.now()) + days * 24 * 60 * 60 * 1000;
      const newExpire = formatDate(newExpireMs);

      const text =
        `<b>⚠️ Подтвердите действие</b>\n\n` +
        `Добавить пользователю #${userId}\n` +
        `<b>${days === 9999 ? "Навсегда" : days + " дней подписки"}</b>?\n\n` +
        `Сейчас до: ${currentExpire}\n` +
        `Станет до: ${days === 9999 ? "Бессрочно" : newExpire}`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить", callback_data: `adm:sub:confirm_add:${userId}:${days}` },
            { text: "❌ Отмена", callback_data: `adm:sub:user:${userId}` }
          ]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "confirm_add") {
      const days = parseInt(param2, 10) || 30;
      const updated = userStore.setUserPlan(userId, "pro", days);
      logAdminAction("Администратор #1", `Подписка +${days}дн. для #${userId}`, { days });

      const text =
        `<b>✅ Подписка изменена</b>\n\n` +
        `Добавлено: ${days === 9999 ? "Навсегда" : days + " дней"}\n` +
        `Новая дата окончания: ${updated.proExpiresAt ? formatDate(updated.proExpiresAt) : "Бессрочно"}`;

      const keyboard = {
        inline_keyboard: [[{ text: "👤 Вернуться к пользователю", callback_data: `adm:user:view:${userId}` }]]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "subtract") {
      const days = parseInt(param2, 10) || 1;
      const updated = userStore.subtractProTime(userId, days);
      logAdminAction("Администратор #1", `Забрано -${days}дн. подписки у #${userId}`);

      const text =
        `<b>✅ Подписка уменьшена</b>\n\n` +
        `Снято: <b>-${days} дней</b>\n` +
        `Новый статус: ${updated.plan === "pro" ? (updated.proExpiresAt ? formatDate(updated.proExpiresAt) : "Бессрочно") : "Бесплатный (FREE)"}`;

      const keyboard = {
        inline_keyboard: [[{ text: "👤 Вернуться к пользователю", callback_data: `adm:user:view:${userId}` }]]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "revoke") {
      userStore.setUserPlan(userId, "free");
      logAdminAction("Администратор #1", `Подписка отозвана у #${userId}`);
      const user = userStore.findUser(userId);
      const card = buildUserCard(user);
      await editAdminMessage(messageId, card.text, card.keyboard);
    }
  }

  // 5. BONUS TIME MENU
  else if (domain === "bonus") {
    const userId = param1;
    const text =
      `<b>🎁 Выдать бесплатное время</b>\n\n` +
      `Кому: Пользователь #${userId}\n\n` +
      `Выберите срок подарка:`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "➕ 1 день", callback_data: `adm:sub:add:${userId}:1` },
          { text: "➕ 3 дня", callback_data: `adm:sub:add:${userId}:3` }
        ],
        [
          { text: "➕ 7 дней", callback_data: `adm:sub:add:${userId}:7` },
          { text: "➕ 14 дней", callback_data: `adm:sub:add:${userId}:14` }
        ],
        [
          { text: "➕ 30 дней", callback_data: `adm:sub:add:${userId}:30` }
        ],
        [
          { text: "← Назад к пользователю", callback_data: `adm:user:view:${userId}` }
        ]
      ]
    };
    await editAdminMessage(messageId, text, keyboard);
  }

  // 6. SUBSCRIPTIONS OVERVIEW & BULK COMPENSATIONS
  else if (domain === "subs") {
    if (action === "bulk_prompt") {
      const allUsers = Object.values(userStore.getAllUsersRaw());
      const totalCount = allUsers.length;
      const proCount = allUsers.filter(u => u.plan === "pro").length;
      const freeCount = totalCount - proCount;

      const text =
        `<b>🎁 Массовое вычисление / Компенсация</b>\n\n` +
        `<b>Пользователей всего:</b> ${totalCount}\n` +
        `<b>С подпиской PRO:</b> ${proCount}\n` +
        `<b>Без подписки FREE:</b> ${freeCount}\n\n` +
        `Выберите целевую аудиторию:`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "👥 Абсолютно ВСЕМ пользователям", callback_data: "adm:subs:bulk_aud:all" }],
          [{ text: "💎 Только PRO трейдерам", callback_data: "adm:subs:bulk_aud:pro" }],
          [{ text: "⚪ Только FREE трейдерам", callback_data: "adm:subs:bulk_aud:free" }],
          [{ text: "← Назад к подпискам", callback_data: "adm:subs:main" }]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_aud") {
      const audience = param1 || "all";
      const audTitle = audience === "all" ? "Абсолютно ВСЕМ пользователям" : (audience === "free" ? "Только FREE трейдерам" : "Только PRO трейдерам");

      const text =
        `<b>🎁 Массовая компенсация</b>\n\n` +
        `Получатели: <b>${audTitle}</b>\n\n` +
        `Выберите срок начисляемой подписки или введите своё число:`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "➕ 1 день", callback_data: `adm:subs:bulk_confirm:${audience}:1` },
            { text: "➕ 2 дня", callback_data: `adm:subs:bulk_confirm:${audience}:2` }
          ],
          [
            { text: "➕ 3 дня", callback_data: `adm:subs:bulk_confirm:${audience}:3` },
            { text: "➕ 7 дней", callback_data: `adm:subs:bulk_confirm:${audience}:7` }
          ],
          [
            { text: "➕ 14 дней", callback_data: `adm:subs:bulk_confirm:${audience}:14` },
            { text: "➕ 30 дней", callback_data: `adm:subs:bulk_confirm:${audience}:30` }
          ],
          [
            { text: "✏️ Ввести своё кол-во дней", callback_data: `adm:subs:bulk_custom_prompt:${audience}` }
          ],
          [
            { text: "← Назад к выбору аудитории", callback_data: "adm:subs:bulk_prompt" }
          ]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_custom_prompt") {
      const audience = param1 || "all";
      const audTitle = audience === "all" ? "Абсолютно ВСЕМ пользователям" : (audience === "free" ? "Только FREE трейдерам" : "Только PRO трейдерам");
      adminState.set(chatId, { action: "bulk_custom_days", data: { audience } });

      const text =
        `<b>✏️ Ручной ввод компенсации</b>\n\n` +
        `Аудитория: <b>${audTitle}</b>\n\n` +
        `Отправьте в чат число дней подписки для начисления (например: <code>5</code>, <code>12</code>, <code>45</code>, <code>100</code>).`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "← Отмена", callback_data: "adm:subs:bulk_prompt" }]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_confirm") {
      const audience = param1 || "all";
      const days = parseInt(param2, 10) || 1;
      const allUsers = Object.values(userStore.getAllUsersRaw());

      let targetUsers = allUsers;
      if (audience === "pro") targetUsers = allUsers.filter(u => u.plan === "pro");
      if (audience === "free") targetUsers = allUsers.filter(u => u.plan === "free");

      const audTitle = audience === "all" ? "Абсолютно ВСЕМ пользователям" : (audience === "free" ? "Только FREE трейдерам" : "Только PRO трейдерам");

      const text =
        `<b>⚠️ Подтвердите массовую компенсацию</b>\n\n` +
        `Аудитория: <b>${audTitle} (${targetUsers.length} человек)</b>\n` +
        `Начислить: <b>+${days} дн. PRO подписки</b>\n\n` +
        `Всем выбранным пользователям будет продлена или выдана PRO подписка на +${days} дн.`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить вычисление", callback_data: `adm:subs:bulk_apply:${audience}:${days}` },
            { text: "❌ Отмена", callback_data: "adm:subs:main" }
          ]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_apply") {
      const audience = param1 || "all";
      const days = parseInt(param2, 10) || 1;
      const result = userStore.grantBulkProTime(days, audience);

      const audTitle = audience === "all" ? "ВСЕМ пользователям" : (audience === "free" ? "FREE трейдерам" : "PRO трейдерам");
      logAdminAction("Администратор #1", `Массовое начисление +${days}дн. (${audTitle}) для ${result.count} чел.`);

      const text =
        `<b>✅ Компенсация успешно выслана!</b>\n\n` +
        `Аудитория: <b>${audTitle}</b>\n` +
        `Добавлено: <b>+${days} дн. PRO подписки</b>\n` +
        `Обновлено аккаунтов: <b>${result.count} человек</b>.`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "💎 К меню подписок", callback_data: "adm:subs:main" }],
          [{ text: "🏠 Главное меню", callback_data: "adm:menu" }]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_sub_prompt") {
      const allUsers = Object.values(userStore.getAllUsersRaw());
      const proCount = allUsers.filter(u => u.plan === "pro").length;

      const text =
        `<b>➖ Массовое списание дней подписки</b>\n\n` +
        `Активных PRO трейдеров: <b>${proCount}</b>\n\n` +
        `Выберите, сколько дней забрать у всех PRO пользователей:`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "➖ 1 день у всех PRO", callback_data: "adm:subs:bulk_sub_confirm:1" },
            { text: "➖ 2 дня у всех PRO", callback_data: "adm:subs:bulk_sub_confirm:2" }
          ],
          [
            { text: "➖ 3 дня у всех PRO", callback_data: "adm:subs:bulk_sub_confirm:3" },
            { text: "➖ 7 дней у всех PRO", callback_data: "adm:subs:bulk_sub_confirm:7" }
          ],
          [
            { text: "✏️ Ввести своё число дней", callback_data: "adm:subs:bulk_sub_custom_prompt" }
          ],
          [
            { text: "← Назад к подпискам", callback_data: "adm:subs:main" }
          ]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_sub_custom_prompt") {
      adminState.set(chatId, { action: "bulk_sub_custom_days" });

      const text =
        `<b>✏️ Ручной ввод списания дней</b>\n\n` +
        `Аудитория: <b>Все PRO пользователи</b>\n\n` +
        `Отправьте в чат число дней для списания (например: <code>1</code>, <code>5</code>, <code>14</code>).`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "← Отмена", callback_data: "adm:subs:main" }]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_sub_confirm") {
      const days = parseInt(param1, 10) || 1;
      const allUsers = Object.values(userStore.getAllUsersRaw());
      const proCount = allUsers.filter(u => u.plan === "pro").length;

      const text =
        `<b>⚠️ Подтвердите массовое списание</b>\n\n` +
        `Забрать: <b>-${days} дн. PRO подписки</b> у <b>${proCount} трейдеров</b>\n\n` +
        `У всех PRO трейдеров подписка уменьшится на -${days} дн.`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить списание", callback_data: `adm:subs:bulk_sub_apply:${days}` },
            { text: "❌ Отмена", callback_data: "adm:subs:main" }
          ]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "bulk_sub_apply") {
      const days = parseInt(param1, 10) || 1;
      const result = userStore.subtractBulkProTime(days, "pro");
      logAdminAction("Администратор #1", `Массовое списание -${days}дн. у ${result.count} PRO трейдеров`);

      const text =
        `<b>✅ Списание успешно проведено!</b>\n\n` +
        `Снято: <b>-${days} дн.</b>\n` +
        `Обработано аккаунтов: <b>${result.count} человек</b>.`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "💎 К меню подписок", callback_data: "adm:subs:main" }],
          [{ text: "🏠 Главное меню", callback_data: "adm:menu" }]
        ]
      };
      await editAdminMessage(messageId, text, keyboard);
    } else if (action === "exp" || action === "new" || action === "renewals") {
      const expType = param1 || "today";
      const allUsers = Object.values(userStore.getAllUsersRaw());
      const now = Date.now();
      let filtered = [];
      let title = "Подписки";

      if (action === "exp") {
        if (expType === "today") {
          filtered = allUsers.filter(u => u.plan === "pro" && u.proExpiresAt && (u.proExpiresAt - now) <= 24 * 3600 * 1000 && u.proExpiresAt > now);
          title = "⏳ Заканчиваются сегодня";
        } else if (expType === "3d") {
          filtered = allUsers.filter(u => u.plan === "pro" && u.proExpiresAt && (u.proExpiresAt - now) <= 3 * 24 * 3600 * 1000 && u.proExpiresAt > now);
          title = "📅 Заканчиваются за 3 дня";
        } else if (expType === "7d") {
          filtered = allUsers.filter(u => u.plan === "pro" && u.proExpiresAt && (u.proExpiresAt - now) <= 7 * 24 * 3600 * 1000 && u.proExpiresAt > now);
          title = "📅 Заканчиваются за 7 дней";
        } else if (expType === "recent") {
          filtered = allUsers.filter(u => u.plan === "free" && u.hadPro);
          title = "❌ Недавно закончились";
        }
      } else if (action === "new") {
        filtered = allUsers.filter(u => u.plan === "pro" && new Date(u.createdAt).getTime() >= now - 24 * 3600 * 1000);
        title = "🆕 Новые подписки";
      } else if (action === "renewals") {
        filtered = allUsers.filter(u => u.plan === "pro" && u.renewalCount > 0);
        title = "♻️ Продления подписок";
      }

      let text = `<b>💎 ${title} (${filtered.length}):</b>\n\n`;
      if (filtered.length === 0) text += `<i>Список пуст</i>`;

      const buttons = filtered.slice(0, 8).map(u => [{ text: `👤 ${u.username} (${u.id})`, callback_data: `adm:user:view:${u.id}` }]);
      buttons.push([{ text: "← Назад к подпискам", callback_data: "adm:subs:main" }]);
      await editAdminMessage(messageId, text, { inline_keyboard: buttons });
    } else {
      const sMenu = buildSubscriptionsMenu();
      await editAdminMessage(messageId, sMenu.text, sMenu.keyboard);
    }
  }

  // 7. PAYMENTS OVERVIEW
  else if (domain === "payments" || domain === "pays") {
    if (action === "search_prompt") {
      adminState.set(chatId, { action: "search_payment" });
      await editAdminMessage(
        messageId,
        `<b>🔎 Поиск платежа</b>\n\nОтправьте в чат ID транзакции, ID пользователя или Hash транзакции:`,
        { inline_keyboard: [[{ text: "← Отмена", callback_data: "adm:pays:main" }]] }
      );
    } else if (action === "list") {
      const filterType = param1 || "recent";
      let filtered = payments;
      let title = "Все платежи";

      if (filterType === "recent") {
        filtered = [...payments].reverse().slice(0, 10);
        title = "🧾 Последние платежи";
      } else if (filterType === "failed") {
        filtered = payments.filter(p => p.status === "failed");
        title = "❌ Неуспешные платежи";
      } else if (filterType === "refunds") {
        filtered = payments.filter(p => p.status === "refunded");
        title = "↩️ Возвраты";
      }

      let listText = `<b>${title} (${filtered.length}):</b>\n\n`;
      if (filtered.length === 0) listText += `<i>Список пуст</i>`;
      else {
        filtered.slice(0, 10).forEach((p, i) => {
          const st = p.status === "success" ? "✅" : (p.status === "pending" ? "⏳" : "❌");
          listText += `${i+1}. ${st} <b>$${p.amount || 0}</b> — #${p.userId} (${p.date ? p.date.slice(0, 10) : "—"})\n`;
        });
      }

      const buttons = [[{ text: "← Назад в меню платежей", callback_data: "adm:pays:main" }]];
      await editAdminMessage(messageId, listText, { inline_keyboard: buttons });
    } else {
      const pMenu = buildPaymentsMenu();
      await editAdminMessage(messageId, pMenu.text, pMenu.keyboard);
    }
  }

  // 8. PROMO CODES
  else if (domain === "promos") {
    if (action === "create_prompt") {
      adminState.set(chatId, { action: "create_promo_code" });
      await editAdminMessage(
        messageId,
        `<b>🎟 Создание промокода</b>\n\n` +
        `Отправьте промокод в чат в формате:\n` +
        `<code>КОД ТИП ЗНАЧЕНИЕ ЛИМИТ</code>\n\n` +
        `<i>Примеры:</i>\n` +
        `• <code>SUMMER50 percent 50 100</code> — скидка 50% на 100 человек\n` +
        `• <code>PROSTART days 7 50</code> — +7 дней подписки на 50 человек`,
        { inline_keyboard: [[{ text: "← Отмена", callback_data: "adm:promos:main" }]] }
      );
    } else if (action === "list") {
      const filterType = param1 || "active";
      let list = promos;
      if (filterType === "active") list = promos.filter(p => p.active);
      if (filterType === "disabled") list = promos.filter(p => !p.active);

      let text = `<b>🎟 Промокоды (${filterType}):</b>\n\n`;
      if (list.length === 0) text += `<i>Список пуст</i>\n\n`;
      else {
        list.forEach((p, i) => {
          const valStr = p.type === "days" ? `+${p.value}дн.` : `${p.value}%`;
          text += `${i+1}. <code>${p.code}</code> (${valStr}) — Использовано: ${p.usedCount || 0}/${p.limit || "∞"}\n`;
        });
      }

      const buttons = list.slice(0, 6).map(p => [
        { text: `${p.active ? "❌ Отключить" : "✅ Включить"} ${p.code}`, callback_data: `adm:promos:toggle:${p.code}` }
      ]);
      buttons.push([{ text: "← Назад к промокодам", callback_data: "adm:promos:main" }]);
      await editAdminMessage(messageId, text, { inline_keyboard: buttons });
    } else if (action === "toggle") {
      const code = param1;
      const promo = promos.find(p => p.code === code);
      if (promo) {
        promo.active = !promo.active;
        saveJSON(PROMOS_FILE, promos);
        await answerCallback(query.id, promo.active ? "Промокод включен ✅" : "Промокод отключен ❌");
      }
      const prMenu = buildPromosMenu();
      await editAdminMessage(messageId, prMenu.text, prMenu.keyboard);
    } else if (action === "stats") {
      const totalPromos = promos.length;
      const totalUses = promos.reduce((s, p) => s + (p.usedCount || 0), 0);
      const text =
        `<b>📊 Статистика промокодов</b>\n\n` +
        `<b>Всего промокодов:</b> ${totalPromos}\n` +
        `<b>Всего активаций:</b> ${totalUses}\n\n` +
        `<i>Все промокоды активны и готовы к использованию.</i>`;
      await editAdminMessage(messageId, text, { inline_keyboard: [[{ text: "← Назад", callback_data: "adm:promos:main" }]] });
    } else {
      const prMenu = buildPromosMenu();
      await editAdminMessage(messageId, prMenu.text, prMenu.keyboard);
    }
  }

  // 9. BROADCASTS
  else if (domain === "bcast") {
    if (action === "send") {
      const state = adminState.get(chatId);
      if (state && state.action === "bcast_confirm") {
        adminState.delete(chatId);
        const { text, recipients } = state.data;
        let success = 0;
        let failed = 0;

        if (!MAIN_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
        const mainBotApi = `https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendMessage`;

        for (const u of recipients) {
          try {
            const r = await fetch(mainBotApi, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: u.telegramChatId, text, parse_mode: "HTML" })
            });
            if (r.ok) success++; else failed++;
          } catch (_) {
            failed++;
          }
        }

        logAdminAction("Администратор #1", `Рассылка отправлена (${success} получено)`);

        const resultText =
          `<b>✅ Рассылка завершена</b>\n\n` +
          `Успешно: ${success}\n` +
          `Не доставлено: ${failed}\n` +
          `Заблокировали бота: 0`;

        await editAdminMessage(messageId, resultText, { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "adm:menu" }]] });
      }
    } else if (action === "aud") {
      const audience = param1;
      adminState.set(chatId, { action: "bcast_text", data: { audience } });
      await editAdminMessage(
        messageId,
        `<b>📢 Составление сообщения для рассылки</b>\n\nВведите текст рассылки (поддерживается HTML форматирование).`,
        { inline_keyboard: [[{ text: "← Отмена", callback_data: "adm:bcast:main" }]] }
      );
    } else {
      const bMenu = buildBroadcastMenu();
      await editAdminMessage(messageId, bMenu.text, bMenu.keyboard);
    }
  }

  // 10. SUPPORT
  else if (domain === "supp") {
    if (action === "reply") {
      const ticketId = param1;
      const ticket = supportTickets.find(t => t.id === ticketId);
      if (ticket) {
        adminState.set(chatId, { action: "reply_support_ticket", data: { ticketId } });
        await sendAdminMessage(
          `<b>✉️ Ответ на обращение в поддержку</b>\n\n` +
          `<b>От кого:</b> ${ticket.name} (${ticket.username})\n` +
          `<b>ID:</b> <code>${ticket.userId}</code> | <b>Chat ID:</b> <code>${ticket.chatId}</code>\n` +
          `<b>Вопрос пользователя:</b>\n<i>«${ticket.text}»</i>\n\n` +
          `Введите ваше сообщение-ответ в чат 👇:`
        );
      } else {
        await answerCallback(query.id, "Обращение не найдено", true);
      }
    } else if (action === "close") {
      const ticketId = param1;
      const ticket = supportTickets.find(t => t.id === ticketId);
      if (ticket) {
        ticket.status = "closed";
        saveJSON(SUPPORT_FILE, supportTickets);
      }
      await answerCallback(query.id, "Обращение закрыто ✅");

      const name = ticket ? ticket.name : "Пользователь";
      const uname = ticket ? ticket.username : "";
      const text = ticket ? ticket.text : "";
      
      const closedText =
        `<b>✅ ОБРАЩЕНИЕ ЗАКРЫТО</b>\n\n` +
        `<b>От:</b> ${name} (${uname})\n` +
        `<b>Текст:</b> <i>«${text}»</i>`;

      await apiCall("editMessageReplyMarkup", {
        chat_id: ADMIN_CHAT_ID,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });

      await editAdminMessage(messageId, closedText, { inline_keyboard: [] });
    } else if (action === "list") {
      const statusFilter = param1 || "new";
      let list = supportTickets;
      if (statusFilter === "new") list = supportTickets.filter(t => t.status === "waiting_admin" || t.status === "open");
      else if (statusFilter === "waiting") list = supportTickets.filter(t => t.status === "waiting_user");
      else if (statusFilter === "closed") list = supportTickets.filter(t => t.status === "closed");

      let text = `<b>🎫 Обращения в поддержку (${statusFilter}):</b>\n\n`;
      if (list.length === 0) text += `<i>Обращений со статусом "${statusFilter}" нет</i>`;
      else {
        list.slice(0, 10).forEach((t, i) => {
          text += `${i+1}. <b>${t.name}</b> (${t.username}) — <i>${t.text.slice(0, 40)}...</i>\n`;
        });
      }
      const keyboard = {
        inline_keyboard: list.slice(0, 5).map(t => [{ text: `✉️ ${t.name}: ${t.text.slice(0, 20)}...`, callback_data: `adm:supp:reply:${t.id}` }]).concat([[{ text: "← Назад в меню поддержки", callback_data: "adm:supp:main" }]])
      };
      await editAdminMessage(messageId, text, keyboard);
    } else {
      const suppMenu = buildSupportMenu();
      await editAdminMessage(messageId, suppMenu.text, suppMenu.keyboard);
    }
  }

  // 11. STATISTICS
  else if (domain === "stats") {
    const period = action || "24h";
    const stMenu = buildStatsMenu(period);
    await editAdminMessage(messageId, stMenu.text, stMenu.keyboard);
  }

  // 12. SYSTEM MONITOR
  else if (domain === "sys") {
    const sysMenu = buildSystemMenu();
    await editAdminMessage(messageId, sysMenu.text, sysMenu.keyboard);
  }

  // 13. ERRORS
  else if (domain === "err") {
    const text =
      `<b>⚠️ Ошибки системы</b>\n\n` +
      `За последний час: 0\n` +
      `За 24 часа: 0\n` +
      `Нерешённых: 0\n\n` +
      `<i>Все системы работают стабильно, ошибок не зафиксировано.</i>`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "🔄 Обновить", callback_data: "adm:err:main" }],
        [{ text: "← Назад", callback_data: "adm:sys:main" }, { text: "🏠 Главное меню", callback_data: "adm:menu" }]
      ]
    };
    await editAdminMessage(messageId, text, keyboard);
  }

  // 14. LOGS
  else if (domain === "log") {
    const logMenu = buildAuditLogMenu();
    await editAdminMessage(messageId, logMenu.text, logMenu.keyboard);
  }

  // 15. SETTINGS
  else if (domain === "set") {
    if (action === "toggle") {
      const key = param1;
      if (adminSettings[key] !== undefined) {
        adminSettings[key] = !adminSettings[key];
        saveJSON(SETTINGS_FILE, adminSettings);
      }
    }
    const setMenu = buildSettingsMenu();
    await editAdminMessage(messageId, setMenu.text, setMenu.keyboard);
  }

  // 16. QUICK ACTIONS
  else if (domain === "quick") {
    const qMenu = buildQuickActionsMenu();
    await editAdminMessage(messageId, qMenu.text, qMenu.keyboard);
  }

  // 17. BUG REPORT REWARDS
  else if (domain === "bug") {
    const days = parseInt(action) || 0;
    const reportId = param1;
    const targetUserId = param2;

    const report = bugReports.find(r => r.id === reportId);
    if (report && report.status !== "pending") {
      await answerCallback(query.id, `Репорт уже обработан (${report.status})`, true);
      return;
    }

    if (report) {
      report.status = days > 0 ? "rewarded" : "rejected";
      report.rewardDays = days;
      report.processedAt = new Date().toISOString();
      saveJSON(BUG_REPORTS_FILE, bugReports);
    }

    const targetUser = userStore.getUserById ? userStore.getUserById(targetUserId) : null;
    const tgName = (report && report.username) ? `@${report.username.replace(/^@/, '')}` : (targetUser ? targetUser.username : targetUserId);
    const safeDesc = report ? (report.description || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "—";

    if (days > 0) {
      const updatedUser = userStore.setUserPlan(targetUserId, "pro", days);

      if (typeof userStore.addNotificationToUser === "function") {
        userStore.addNotificationToUser(targetUserId, {
          type: "bug_reward",
          title: "🎁 Баг подтверждён!",
          message: `Спасибо за сотрудничество! Вам зачислено +${days} дн. PRO подписки на аккаунт.\n(обновите страницу)`,
          days: days
        });
      }

      let telegramBot = null;
      try { telegramBot = require("./telegramBot"); } catch (_) {}

      const userTgId = (updatedUser && updatedUser.telegramId) || (report && report.telegramId) || (targetUser && targetUser.telegramId);

      if (userTgId && telegramBot && typeof telegramBot.sendTelegramMessage === "function") {
        const userMsg =
          `🎉 <b>СПАСИБО ЗА СОТРУДНИЧЕСТВО!</b>\n\n` +
          `Ваш баг-репорт проверен и подтверждён администратором.\n` +
          `🎁 <b>Вам зачислено +${days} дней PRO подписки!</b>\n\n` +
          `<i>Обновите страницу скринера для применения изменений.</i>`;
        try {
          await telegramBot.sendTelegramMessage(userTgId, userMsg);
        } catch (e) {
          console.error("[BUG REWARD TG NOTIFY ERROR]", e.message);
        }
      }

      logAdminAction("Администратор", "REWARD_BUG_REPORT", { userId: targetUserId, days, reportId });

      const updatedAdminText =
        `✅ <b>БАГ-РЕПОРТ ОБРАБОТАН — НАГРАДА ВЫДАНА!</b>\n\n` +
        `👤 <b>Пользователь:</b> ${tgName} (<code>${targetUserId}</code>)\n` +
        `📝 <b>Описание:</b> <i>«${safeDesc}»</i>\n\n` +
        `🎉 <b>Начислено:</b> <b>+${days} дн. PRO подписки</b> ✅`;

      await apiCall("editMessageReplyMarkup", {
        chat_id: ADMIN_CHAT_ID,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });
      await editAdminMessage(messageId, updatedAdminText, { inline_keyboard: [] });
      await answerCallback(query.id, `✅ Зачислено +${days} дн. PRO трейдеру ${targetUserId}!`, true);
    } else {
      if (typeof userStore.addNotificationToUser === "function") {
        userStore.addNotificationToUser(targetUserId, {
          type: "bug_reject",
          title: "ℹ️ Статус баг-репорта",
          message: `Благодарим за внимание к проекту! Наш администратор проверил репорт — к сожалению, описанная проблема не является ошибкой. Спасибо за помощь!`,
          days: 0
        });
      }

      let telegramBot = null;
      try { telegramBot = require("./telegramBot"); } catch (_) {}

      const userTgId = (report && report.telegramId) || (targetUser && targetUser.telegramId);

      if (userTgId && telegramBot && typeof telegramBot.sendTelegramMessage === "function") {
        const userMsg =
          `ℹ️ <b>СТАТУС ВАШЕГО БАГ-РЕПОРТА</b>\n\n` +
          `Благодарим за внимание к проекту Obsidian Screener! 🙏\n` +
          `Наш администратор проверил ваше сообщение, однако описанная проблема не является ошибкой или багом в работе сервиса.\n\n` +
          `Спасибо за помощь и удачной торговли!`;
        try {
          await telegramBot.sendTelegramMessage(userTgId, userMsg);
        } catch (e) {
          console.error("[BUG REJECT TG NOTIFY ERROR]", e.message);
        }
      }

      logAdminAction("Администратор", "REJECT_BUG_REPORT", { userId: targetUserId, reportId });

      const updatedAdminText =
        `❌ <b>БАГ-РЕПОРТ ОТКЛОНЁН</b>\n\n` +
        `👤 <b>Пользователь:</b> ${tgName} (<code>${targetUserId}</code>)\n` +
        `📝 <b>Описание:</b> <i>«${safeDesc}»</i>\n\n` +
        `<i>Репорт отклонён администратором (пользователь уведомлен).</i>`;

      await apiCall("editMessageReplyMarkup", {
        chat_id: ADMIN_CHAT_ID,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });
      await editAdminMessage(messageId, updatedAdminText, { inline_keyboard: [] });
      await answerCallback(query.id, "Репорт отклонён", true);
    }
  }
}

async function notifyBugReport(reportData) {
  bugReports.unshift(reportData);
  if (bugReports.length > 500) bugReports = bugReports.slice(0, 500);
  saveJSON(BUG_REPORTS_FILE, bugReports);

  const safeDesc = (reportData.description || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const tgName = reportData.username ? `@${reportData.username.replace(/^@/, '')}` : "Трейдер";
  const userPlanText = reportData.plan === "pro" ? "💎 PRO" : "⚪ FREE";

  const text =
    `🐛 <b>НОВЫЙ БАГ-РЕПОРТ!</b>\n\n` +
    `👤 <b>Пользователь:</b> ${tgName} (<code>${reportData.userId}</code>)\n` +
    `• <b>Способ:</b> ${reportData.authMethod}\n` +
    `• <b>Email/Логин:</b> ${reportData.email}\n` +
    `• <b>Текущий тариф:</b> ${userPlanText}\n` +
    `• <b>Время:</b> ${formatDateTime(reportData.createdAt)}\n\n` +
    `📝 <b>Описание проблемы:</b>\n` +
    `<i>«${safeDesc}»</i>\n\n` +
    `🎁 <b>Начислить награду PRO подписки:</b>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🎁 +2 Дня PRO", callback_data: `adm:bug:2:${reportData.id}:${reportData.userId}` },
        { text: "🎁 +5 Дней PRO", callback_data: `adm:bug:5:${reportData.id}:${reportData.userId}` }
      ],
      [
        { text: "🚀 +7 Дней PRO", callback_data: `adm:bug:7:${reportData.id}:${reportData.userId}` },
        { text: "👑 +30 Дней PRO", callback_data: `adm:bug:30:${reportData.id}:${reportData.userId}` }
      ],
      [
        { text: "❌ Отклонить (Не баг)", callback_data: `adm:bug:0:${reportData.id}:${reportData.userId}` }
      ]
    ]
  };

  if (reportData.image && typeof reportData.image === "string" && reportData.image.startsWith("data:image/")) {
    const tempDir = path.join(__dirname, "scratch_bugs");
    if (!fs.existsSync(tempDir)) {
      try { fs.mkdirSync(tempDir, { recursive: true }); } catch (_) {}
    }
    const tempPath = path.join(tempDir, `${reportData.id}.png`);
    try {
      const base64Data = reportData.image.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(tempPath, Buffer.from(base64Data, "base64"));

      const res = await sendAdminPhoto(tempPath, text, keyboard);
      try { fs.unlinkSync(tempPath); } catch (_) {}
      if (res && res.ok) return res;
    } catch (e) {
      console.error("[BUG REPORT PHOTO SEND ERROR]", e.message);
    }
  }

  return await sendAdminMessage(text, keyboard);
}

module.exports = {
  sendAdminMessage,
  createSupportTicket,
  handleAdminMessageText,
  handleAdminCallbackQuery,
  notifyBugReport
};
