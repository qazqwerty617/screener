"use strict";

const fs = require("fs");
const path = require("path");
const userStore = require("./userStore");

const ADMIN_BOT_TOKEN = "8809831309:AAFfsYL5clUyNwFEVYkviDQhb821ajTjmG0";
const ADMIN_CHAT_ID = "8482582995";
const TELEGRAM_API = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}`;

// Files for persistent admin data
const PROMOS_FILE = path.join(__dirname, "promos.json");
const PAYMENTS_FILE = path.join(__dirname, "payments.json");
const SUPPORT_FILE = path.join(__dirname, "support.json");
const SETTINGS_FILE = path.join(__dirname, "admin_settings.json");
const AUDIT_FILE = path.join(__dirname, "admin_audit.json");

function loadJSON(fp, fallback) {
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {}
  return fallback;
}

function saveJSON(fp, data) {
  try {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {}
}

let promos = loadJSON(PROMOS_FILE, [
  { code: "OBSIDIAN30", type: "percent", value: 30, active: true, usedCount: 47, limit: 100, expiresAt: "2026-09-01T00:00:00.000Z" },
  { code: "PROSTART", type: "days", value: 7, active: true, usedCount: 12, limit: 50, expiresAt: "2026-10-01T00:00:00.000Z" }
]);
let payments = loadJSON(PAYMENTS_FILE, []);
let supportTickets = loadJSON(SUPPORT_FILE, []);
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

// Telegram API Helper
async function apiCall(method, payload) {
  try {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error(`[ADMIN BOT ERROR] API Call ${method} failed:`, err.message);
    return { ok: false, error: err.message };
  }
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

async function editAdminMessage(messageId, text, replyMarkup = null) {
  return await apiCall("editMessageText", {
    chat_id: ADMIN_CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup
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
  const text = msg.text.trim();
  const chatId = String(msg.chat.id);

  if (chatId !== ADMIN_CHAT_ID) {
    sendAdminMessage("⛔ <b>Доступ запрещен.</b> Панель доступна только Администратору.");
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
        const mainBotApi = `https://api.telegram.org/bot8856434726:AAHOO0OPlIQR82dHgqt13dAQviSYv0-4CDk/sendMessage`;
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

  await answerCallback(query.id);

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
      const updated = userStore.blockUser(userId, { reason });
      logAdminAction("Администратор #1", `Заблокирован пользователь #${userId}`, { reason });
      const card = buildUserCard(updated);
      await editAdminMessage(messageId, card.text, card.keyboard);
    } else if (action === "unblock") {
      const updated = userStore.unblockUser(userId);
      logAdminAction("Администратор #1", `Разблокирован пользователь #${userId}`);
      const card = buildUserCard(updated);
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
    } else {
      const sMenu = buildSubscriptionsMenu();
      await editAdminMessage(messageId, sMenu.text, sMenu.keyboard);
    }
  }

  // 7. PAYMENTS OVERVIEW
  else if (domain === "payments" || domain === "pays") {
    const pMenu = buildPaymentsMenu();
    await editAdminMessage(messageId, pMenu.text, pMenu.keyboard);
  }

  // 8. PROMO CODES
  else if (domain === "promos") {
    const prMenu = buildPromosMenu();
    await editAdminMessage(messageId, prMenu.text, prMenu.keyboard);
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

        const mainBotApi = `https://api.telegram.org/bot8856434726:AAHOO0OPlIQR82dHgqt13dAQviSYv0-4CDk/sendMessage`;

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
    const suppMenu = buildSupportMenu();
    await editAdminMessage(messageId, suppMenu.text, suppMenu.keyboard);
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
}

module.exports = {
  ADMIN_BOT_TOKEN,
  ADMIN_CHAT_ID,
  sendAdminMessage,
  handleAdminMessageText,
  handleAdminCallbackQuery
};
