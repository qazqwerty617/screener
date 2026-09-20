"use strict";

const { createHmac, randomBytes, randomInt, timingSafeEqual } = require("crypto");
const nodemailer = require("nodemailer");

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_PENDING = 5000;

function createEmailVerification({ env = process.env, sendMail, now = Date.now } = {}) {
  const pending = new Map();
  const byEmail = new Map();
  const secret = randomBytes(32);
  let transport;

  function configured() {
    return Boolean(sendMail || (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM));
  }

  function cleanup() {
    const current = now();
    for (const [id, item] of pending) {
      if (item.expiresAt <= current) {
        pending.delete(id);
        if (byEmail.get(item.email) === id) byEmail.delete(item.email);
      }
    }
  }

  function digest(id, code) {
    return createHmac("sha256", secret).update(`${id}:${code}`).digest();
  }

  function mailer() {
    if (!transport) {
      const port = Number(env.SMTP_PORT || 465);
      if (![465, 587].includes(port)) throw new Error("Некорректный SMTP_PORT");
      transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        requireTLS: port === 587,
        disableFileAccess: true,
        disableUrlAccess: true,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });
    }
    return transport;
  }

  async function requestCode(email) {
    if (!configured()) throw new Error("Отправка писем пока не настроена. Обратитесь в поддержку.");
    cleanup();
    const previousId = byEmail.get(email);
    const previous = previousId && pending.get(previousId);
    if (previous && now() - previous.sentAt < RESEND_WAIT_MS) {
      throw new Error("Новый код можно запросить через минуту");
    }
    if (pending.size >= MAX_PENDING) throw new Error("Слишком много запросов. Попробуйте позже.");

    const id = randomBytes(24).toString("hex");
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const item = { email, hash: digest(id, code), attempts: 0, sentAt: now(), expiresAt: now() + CODE_LIFETIME_MS, busy: true };
    pending.set(id, item);
    byEmail.set(email, id);
    const displayCode = `${code.slice(0, 3)} ${code.slice(3)}`;
    const message = {
      from: env.SMTP_FROM,
      to: email,
      subject: "Код подтверждения Obsidian Pro",
      text: `Ваш код подтверждения: ${displayCode}\n\nКод действителен 10 минут. Если вы не регистрировались в Obsidian Pro, просто проигнорируйте это письмо.`,
      html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="margin:0;padding:32px 12px;background:#0d0f16;font-family:Arial,sans-serif;color:#f4f5fb"><div style="max-width:480px;margin:auto;padding:32px;border:1px solid #303449;border-radius:18px;background:#191c29"><div style="color:#ab8cff;font-size:13px;font-weight:700;letter-spacing:2px">OBSIDIAN PRO</div><h1 style="font-size:24px;margin:24px 0 8px">Подтвердите ваш email</h1><p style="color:#b8bccb;line-height:1.6">Введите этот код на сайте, чтобы завершить регистрацию.</p><div style="margin:28px 0;padding:18px;text-align:center;border-radius:12px;background:#29243e;color:#fff;font-size:34px;font-weight:700;letter-spacing:8px">${displayCode}</div><p style="color:#b8bccb;font-size:13px;line-height:1.6">Код действует 10 минут. Если вы не запрашивали регистрацию, просто проигнорируйте это письмо.</p></div></body></html>`,
    };
    try {
      await (sendMail ? sendMail(message) : mailer().sendMail(message));
      item.busy = false;
      if (previousId) pending.delete(previousId);
      return { challengeId: id, expiresInSeconds: 600 };
    } catch (err) {
      pending.delete(id);
      if (byEmail.get(email) === id) {
        if (previous && previous.expiresAt > now()) byEmail.set(email, previousId);
        else byEmail.delete(email);
      }
      throw new Error("Не удалось отправить письмо. Попробуйте позже.");
    }
  }

  function take(email, challengeId, code) {
    cleanup();
    const item = pending.get(String(challengeId || ""));
    if (!item || item.busy || item.email !== email) return false;
    item.attempts++;
    const validFormat = /^\d{6}$/.test(String(code || ""));
    const supplied = digest(challengeId, validFormat ? code : "invalid");
    if (!validFormat || !timingSafeEqual(item.hash, supplied)) {
      if (item.attempts >= MAX_ATTEMPTS) {
        pending.delete(challengeId);
        if (byEmail.get(email) === challengeId) byEmail.delete(email);
      }
      return false;
    }
    pending.delete(challengeId);
    if (byEmail.get(email) === challengeId) byEmail.delete(email);
    return item;
  }

  function restore(challengeId, item) {
    if (item && item.expiresAt > now() && !byEmail.has(item.email)) {
      pending.set(challengeId, item);
      byEmail.set(item.email, challengeId);
    }
  }

  return { configured, requestCode, take, restore };
}

module.exports = { createEmailVerification };
