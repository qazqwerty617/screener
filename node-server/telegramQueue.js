"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// telegramQueue.js — Single global outbound Telegram queue.
//
// Every 24/7 alert send funnels through here so that:
//   • the bot never exceeds Telegram's global (~30 msg/s) or per-chat (~1 msg/s)
//     limits, which was the source of thousands of "Too Many Requests" drops;
//   • a 429 is honoured (retry_after) and the message is retried instead of lost;
//   • one rendered chart is uploaded once and reused via file_id for every other
//     recipient of the same alert;
//   • callers get a truthful success/failure result so they can decide whether to
//     arm an alert cooldown.
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_QUEUE = 400;              // hard cap: bounded memory under a market-wide move
const GLOBAL_MIN_INTERVAL_MS = 45;  // ~22 sends/sec globally (Telegram allows ~30)
const PER_CHAT_MIN_INTERVAL_MS = 1100; // Telegram allows ~1 msg/sec per chat
const MAX_ATTEMPTS = 3;
const PHOTO_TIMEOUT_MS = 15000;
const TEXT_TIMEOUT_MS = 8000;
const GROUP_TTL_MS = 10 * 60 * 1000;

const queue = [];
let workerRunning = false;
let globalPausedUntil = 0;
let lastGlobalSendAt = 0;

const chatNextAllowedAt = new Map(); // chatId -> timestamp
const groupFileIds = new Map();      // group token -> { fileId, at }

const stats = {
  enqueued: 0,
  sent: 0,
  failed: 0,
  dropped: 0,
  rateLimited: 0,
  retried: 0
};

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN || "";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms > 0 ? ms : 0));
}

function pruneGroups(now) {
  if (groupFileIds.size < 200) return;
  for (const [key, entry] of groupFileIds) {
    if (now - entry.at > GROUP_TTL_MS) groupFileIds.delete(key);
  }
}

function pruneChatTimers(now) {
  if (chatNextAllowedAt.size < 2000) return;
  for (const [key, at] of chatNextAllowedAt) {
    if (at < now - 60000) chatNextAllowedAt.delete(key);
  }
}

// Telegram reports the wait either at the top level or inside `parameters`.
function extractRetryAfter(parsed) {
  if (!parsed) return 0;
  const raw = (parsed.parameters && parsed.parameters.retry_after) || parsed.retry_after;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return Math.min(secs, 900) * 1000; // never park an item for more than 15 min
}

// A permanent rejection: retrying cannot succeed, so fail fast and free the slot.
function isPermanentFailure(parsed) {
  if (!parsed) return false;
  const code = Number(parsed.error_code);
  if (code === 400 || code === 401 || code === 403 || code === 404) return true;
  return false;
}

async function sendPhotoRequest(token, chatId, caption, photoBuffer) {
  const blob = new Blob([photoBuffer], { type: "image/png" });
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", blob, "chart_alert.png");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS)
  });
  return res.json();
}

async function sendPhotoByFileId(token, chatId, caption, fileId) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(chatId),
      photo: fileId,
      caption,
      parse_mode: "HTML"
    }),
    signal: AbortSignal.timeout(TEXT_TIMEOUT_MS)
  });
  return res.json();
}

async function sendTextRequest(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(chatId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(TEXT_TIMEOUT_MS)
  });
  return res.json();
}

function extractFileId(parsed) {
  const photos = parsed && parsed.result && parsed.result.photo;
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return photos[photos.length - 1].file_id || null;
}

// Performs a single delivery attempt. Returns:
//   { ok: true, fileId }        delivered
//   { ok: false, retryAfterMs } transient; caller should requeue
//   { ok: false, permanent }    give up
async function attemptDelivery(item) {
  const token = getBotToken();
  if (!token) return { ok: false, permanent: true, reason: "NO_BOT_TOKEN" };

  const caption = item.text.length > 1024 ? `${item.text.slice(0, 1020)}...` : item.text;
  const now = Date.now();

  // Reuse an already-uploaded chart when this alert fans out to several chats.
  let fileId = item.fileId || null;
  if (!fileId && item.group) {
    const cached = groupFileIds.get(item.group);
    if (cached && now - cached.at < GROUP_TTL_MS) fileId = cached.fileId;
  }

  if (fileId) {
    try {
      const parsed = await sendPhotoByFileId(token, item.chatId, caption, fileId);
      if (parsed && parsed.ok) return { ok: true, fileId };
      const retryAfterMs = extractRetryAfter(parsed);
      if (retryAfterMs) return { ok: false, retryAfterMs, global: true };
      // A stale file_id is a 400: fall through to a fresh upload or plain text.
      if (item.group) groupFileIds.delete(item.group);
    } catch (_) {
      // network error: fall through to the remaining strategies
    }
  }

  if (item.photoBuffer && Buffer.isBuffer(item.photoBuffer)) {
    try {
      const parsed = await sendPhotoRequest(token, item.chatId, caption, item.photoBuffer);
      if (parsed && parsed.ok) {
        const uploaded = extractFileId(parsed);
        if (uploaded && item.group) groupFileIds.set(item.group, { fileId: uploaded, at: Date.now() });
        return { ok: true, fileId: uploaded };
      }
      const retryAfterMs = extractRetryAfter(parsed);
      if (retryAfterMs) return { ok: false, retryAfterMs, global: true };
      if (parsed && parsed.description) {
        console.warn(`[TG QUEUE] sendPhoto rejected for ${item.chatId}: ${parsed.description}`);
      }
      // Photo rejected for a non-rate reason — still try to deliver the text.
    } catch (err) {
      console.warn(`[TG QUEUE] sendPhoto error for ${item.chatId}: ${err.message}`);
    }
  }

  try {
    const parsed = await sendTextRequest(token, item.chatId, item.text);
    if (parsed && parsed.ok) return { ok: true, fileId: null };
    const retryAfterMs = extractRetryAfter(parsed);
    if (retryAfterMs) return { ok: false, retryAfterMs, global: true };
    if (isPermanentFailure(parsed)) {
      return { ok: false, permanent: true, reason: parsed.description || `error_code ${parsed.error_code}` };
    }
    return { ok: false, retryAfterMs: 2000 };
  } catch (err) {
    return { ok: false, retryAfterMs: 2000, reason: err.message };
  }
}

function pickNextIndex(now) {
  let earliestBlocked = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (item.notBefore > now) {
      if (item.notBefore < earliestBlocked) earliestBlocked = item.notBefore;
      continue;
    }
    const chatAllowedAt = chatNextAllowedAt.get(item.chatId) || 0;
    if (chatAllowedAt > now) {
      if (chatAllowedAt < earliestBlocked) earliestBlocked = chatAllowedAt;
      continue;
    }
    return { index: i, waitMs: 0 };
  }
  return { index: -1, waitMs: earliestBlocked === Infinity ? 50 : Math.min(earliestBlocked - now, 5000) };
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (queue.length > 0) {
      const now = Date.now();
      pruneGroups(now);
      pruneChatTimers(now);

      if (globalPausedUntil > now) {
        await sleep(Math.min(globalPausedUntil - now, 5000));
        continue;
      }

      const sinceLast = now - lastGlobalSendAt;
      if (sinceLast < GLOBAL_MIN_INTERVAL_MS) {
        await sleep(GLOBAL_MIN_INTERVAL_MS - sinceLast);
        continue;
      }

      const { index, waitMs } = pickNextIndex(now);
      if (index < 0) {
        await sleep(waitMs);
        continue;
      }

      const item = queue.splice(index, 1)[0];
      item.attempts++;
      lastGlobalSendAt = Date.now();
      chatNextAllowedAt.set(item.chatId, lastGlobalSendAt + PER_CHAT_MIN_INTERVAL_MS);

      let result;
      try {
        result = await attemptDelivery(item);
      } catch (err) {
        result = { ok: false, retryAfterMs: 2000, reason: err.message };
      }

      if (result.ok) {
        stats.sent++;
        item.resolve({ ok: true, fileId: result.fileId || null });
        continue;
      }

      if (result.permanent || item.attempts >= MAX_ATTEMPTS) {
        stats.failed++;
        if (result.reason) {
          console.warn(`[TG QUEUE] giving up on ${item.chatId} after ${item.attempts} attempt(s): ${result.reason}`);
        }
        item.resolve({ ok: false, fileId: null, reason: result.reason || "MAX_ATTEMPTS" });
        continue;
      }

      const waitFor = result.retryAfterMs || 2000;
      if (result.global) {
        stats.rateLimited++;
        globalPausedUntil = Date.now() + waitFor;
      }
      stats.retried++;
      item.notBefore = Date.now() + waitFor;
      queue.push(item);
    }
  } finally {
    workerRunning = false;
    // A producer may have enqueued while the loop was winding down.
    if (queue.length > 0) setImmediate(runWorker);
  }
}

/**
 * Queue one outbound alert.
 *
 * @param {object} opts
 * @param {string|number} opts.chatId   destination chat
 * @param {string} opts.text            message body (also used as photo caption)
 * @param {Buffer} [opts.photoBuffer]   optional rendered chart
 * @param {string} [opts.fileId]        known Telegram file_id to reuse
 * @param {string} [opts.group]         shared token so one upload serves many chats
 * @returns {Promise<{ok: boolean, fileId: string|null, reason?: string}>}
 */
function enqueue(opts) {
  const chatId = String((opts && opts.chatId) || "").trim();
  const text = opts && typeof opts.text === "string" ? opts.text : "";
  if (!chatId || !text) return Promise.resolve({ ok: false, fileId: null, reason: "MISSING_TARGET" });
  if (!getBotToken()) return Promise.resolve({ ok: false, fileId: null, reason: "NO_BOT_TOKEN" });

  // Shed load rather than grow without bound: the oldest pending alert is the
  // least useful one, and dropping it keeps chart buffers from piling up.
  while (queue.length >= MAX_QUEUE) {
    const victim = queue.shift();
    stats.dropped++;
    victim.resolve({ ok: false, fileId: null, reason: "QUEUE_OVERFLOW" });
  }

  stats.enqueued++;
  return new Promise(resolve => {
    queue.push({
      chatId,
      text,
      photoBuffer: opts.photoBuffer && Buffer.isBuffer(opts.photoBuffer) ? opts.photoBuffer : null,
      fileId: typeof opts.fileId === "string" && opts.fileId ? opts.fileId : null,
      group: opts.group ? String(opts.group) : null,
      attempts: 0,
      notBefore: 0,
      resolve
    });
    runWorker();
  });
}

function getStats() {
  return { ...stats, pending: queue.length, pausedForMs: Math.max(0, globalPausedUntil - Date.now()) };
}

module.exports = { enqueue, getStats };
