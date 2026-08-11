"use strict";

const fs = require("fs");
const path = require("path");

const EXCEL_FILE_PATH = path.join(__dirname, "users_database.csv");
const PAYMENTS_FILE_PATH = path.join(__dirname, "payments.json");

function generateUsersExcel(usersMap) {
  const users = Object.values(usersMap || {});
  
  let payments = [];
  try {
    if (fs.existsSync(PAYMENTS_FILE_PATH)) {
      payments = JSON.parse(fs.readFileSync(PAYMENTS_FILE_PATH, "utf8"));
    }
  } catch (_) {}

  // UTF-8 BOM so Excel opens with full Russian support & automatic columns
  let csvContent = "\uFEFF";
  
  const headers = [
    "ID Пользователя",
    "Логин",
    "Email",
    "Telegram Username",
    "Telegram ID",
    "Тариф",
    "Статус",
    "Осталось дней подписки",
    "Дата окончания подписки",
    "Дата регистрации",
    "Последняя активность",
    "Telegram-бот подключён",
    "Метки",
    "Количество платежей",
    "Всего потрачено ($)",
    "Заметки администратора"
  ];
  
  csvContent += headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(";") + "\n";
  
  users.forEach(u => {
    const isPro = u.plan === "pro";
    const statusText = u.blocked ? "Заблокирован" : "Активен";
    const planText = isPro ? "PRO" : "FREE";
    
    let daysLeftStr = "—";
    if (isPro) {
      if (!u.proExpiresAt) {
        daysLeftStr = "∞ (Бессрочно)";
      } else {
        const diff = Math.max(0, Math.ceil((u.proExpiresAt - Date.now()) / (1000 * 60 * 60 * 24)));
        daysLeftStr = diff >= 8000 ? "∞ (Бессрочно)" : `${diff} дн.`;
      }
    }
    
    const expireDateStr = isPro ? (u.proExpiresAt ? new Date(u.proExpiresAt).toLocaleString("ru-RU") : "Бессрочно") : "—";
    const regDateStr = u.createdAt ? new Date(u.createdAt).toLocaleString("ru-RU") : "—";
    const lastActiveStr = u.lastActive ? new Date(u.lastActive).toLocaleString("ru-RU") : "—";
    const tgLinkedStr = (u.telegramLinked || u.telegramChatId) ? "Да" : "Нет";
    const tagsStr = Array.isArray(u.tags) ? u.tags.join(", ") : "";
    const tgHandle = u.telegramUsername ? `@${u.telegramUsername.replace(/^@/, "")}` : (u.telegramId ? `id${u.telegramId}` : "—");
    
    const userPays = payments.filter(p => p.userId === u.id);
    const payCount = userPays.length;
    const totalSpent = userPays.filter(p => p.status === "success").reduce((sum, p) => sum + (p.amount || 0), 0);
    const notesStr = u.notes || "—";

    const row = [
      u.id || "—",
      u.username || "—",
      u.email || "—",
      tgHandle,
      u.telegramId || u.telegramChatId || "—",
      planText,
      statusText,
      daysLeftStr,
      expireDateStr,
      regDateStr,
      lastActiveStr,
      tgLinkedStr,
      tagsStr,
      payCount,
      totalSpent.toFixed(2),
      notesStr
    ];
    
    csvContent += row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(";") + "\n";
  });
  
  try {
    fs.writeFileSync(EXCEL_FILE_PATH, csvContent, "utf8");
    console.log(`[EXCEL] Successfully updated users_database.csv (${users.length} users)`);
  } catch (err) {
    console.error("[EXCEL ERROR] Failed to save Excel file:", err.message);
  }
  
  return EXCEL_FILE_PATH;
}

module.exports = {
  EXCEL_FILE_PATH,
  generateUsersExcel
};
