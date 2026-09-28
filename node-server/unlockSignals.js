"use strict";
const { publisher } = require("./newsVerification");
// Discovery is intentionally distinct from a dated, quantified unlock. News
// can discuss a postponement or several projects; do not invent a schedule.
function unlockSignals(items, now = Date.now()) {
  const seen = new Set(), rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item.originVerified || !publisher(item.url) || !Number.isFinite(item.publishedAt) ||
      item.publishedAt < now - 7 * 86400000 || item.publishedAt > now + 60000) continue;
    const text = `${item.title || ""} ${item.context || ""}`.slice(0, 6000);
    if (!/\b(?:token unlocks?|unlock (?:schedule|event)|vesting|supply release)\b|разлок|разблокировк[а-я]* токен/iu.test(text)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    rows.push({ id: item.id, title: item.title, titleRu: item.titleRu || null, url: item.url,
      source: item.source, publishedAt: item.publishedAt, status: "needs_schedule_review" });
  }
  return rows.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 60);
}
module.exports = { unlockSignals };
