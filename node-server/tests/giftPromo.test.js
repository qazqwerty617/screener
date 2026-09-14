"use strict";

process.env.DISABLE_TELEGRAM_BOT = "true";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createPromoStore, PromoError } = require("../promoStore");
const { createPaymentGateway } = require("../paymentGateway");

test("gift promo lifecycle in promoStore", (t) => {
  const tmpFile = path.join(__dirname, `test_promos_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  const store = createPromoStore({ filePath: tmpFile });

  t.after(() => {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
  });

  // 1. Create gift promo
  const giftPromo = store.create({ code: "GIFT7", type: "gift_days", value: 7, limit: 2 });
  assert.equal(giftPromo.code, "GIFT7");
  assert.equal(giftPromo.type, "gift_days");
  assert.equal(giftPromo.value, 7);

  // 2. Checkout quote must reject gift promo
  assert.throws(
    () => store.quote("GIFT7", 3000, 30),
    (err) => err instanceof PromoError && err.code === "PROMO_GIFT_TYPE"
  );

  // 3. Create checkout percent promo and verify profile redeemGift rejects it
  store.create({ code: "SALE20", type: "percent", value: 20, limit: 10 });
  assert.throws(
    () => store.redeemGift("SALE20", "USR-1"),
    (err) => err instanceof PromoError && err.code === "PROMO_CHECKOUT_TYPE"
  );

  // 4. Successful redemption for user 1
  const red1 = store.redeemGift("GIFT7", "USR-1");
  assert.equal(red1.code, "GIFT7");
  assert.equal(red1.days, 7);
  assert.equal(red1.usedCount, 1);

  // 5. User 1 cannot redeem again
  assert.throws(
    () => store.redeemGift("GIFT7", "USR-1"),
    (err) => err instanceof PromoError && err.code === "PROMO_ALREADY_USED"
  );

  // 6. User 2 can redeem
  const red2 = store.redeemGift("GIFT7", "USR-2");
  assert.equal(red2.usedCount, 2);

  // 7. Limit (2) is reached; User 3 is rejected
  assert.throws(
    () => store.redeemGift("GIFT7", "USR-3"),
    (err) => err instanceof PromoError && err.code === "PROMO_LIMIT_REACHED"
  );
});

test("userStore grantGiftDays adds PRO days accurately", async () => {
  const userStore = require("../userStore");
  const rand = Math.random().toString(36).slice(2);
  
  // Register a dummy user
  const { user } = await userStore.registerUser({
    username: `Trader${rand}`,
    email: `gift_${rand}@gmail.com`,
    password: "StrongPassword123!"
  });
  assert.ok(user);
  assert.equal(user.plan, "free");

  // Grant 7 gift days
  const res1 = userStore.grantGiftDays(user.id, "FREE7", 7);
  assert.ok(res1.applied);
  assert.equal(res1.user.plan, "pro");
  assert.ok(res1.user.proDaysLeft >= 6 && res1.user.proDaysLeft <= 8);

  // Attempt duplicate redemption with same promo code
  const resDup = userStore.grantGiftDays(user.id, "FREE7", 7);
  assert.equal(resDup.applied, false);
  assert.equal(resDup.alreadyUsed, true);

  // Grant additional 5 days with a different promo code
  const currentExpiry = userStore.findUser(user.id).proExpiresAt;
  const res2 = userStore.grantGiftDays(user.id, "BONUS5", 5);
  assert.ok(res2.applied);
  const newExpiry = userStore.findUser(user.id).proExpiresAt;
  assert.ok(newExpiry > currentExpiry);
  assert.ok(Math.abs(newExpiry - currentExpiry - 5 * 86400000) < 5000);
});

test("paymentGateway exposes redeemGiftPromo and integrates correctly", async () => {
  const tmpPromoFile = path.join(__dirname, `test_gw_promos_${Date.now()}.json`);
  const promoStore = createPromoStore({ filePath: tmpPromoFile });
  promoStore.create({ code: "GWGIFT", type: "gift_days", value: 14, limit: 5 });

  const userStore = require("../userStore");
  const rand = Math.random().toString(36).slice(2);
  const { user } = await userStore.registerUser({
    username: `GwUser${rand}`,
    email: `gw_${rand}@gmail.com`,
    password: "StrongPassword123!"
  });

  const gateway = createPaymentGateway({
    promoStore,
    userStore
  });

  const result = gateway.redeemGiftPromo("GWGIFT", user.id);
  assert.equal(result.ok, true);
  assert.equal(result.code, "GWGIFT");
  assert.equal(result.days, 14);
  assert.equal(result.user.plan, "pro");

  try { if (fs.existsSync(tmpPromoFile)) fs.unlinkSync(tmpPromoFile); } catch (_) {}
});

test("UI and routes contain profile promo redemption elements and admin bot support", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "js", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "css", "app.css"), "utf8");
  const bot = fs.readFileSync(path.join(root, "adminBot.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "paymentRoutes.js"), "utf8");

  // HTML has input, button and feedback box
  assert.match(html, /id="profile-promo-input"/);
  assert.match(html, /id="profile-promo-btn"[^>]*onclick="redeemProfilePromo\(\);"/);
  assert.match(html, /id="profile-promo-msg"/);

  // CSS has styles
  assert.match(css, /\.profile-promo-section/);
  assert.match(css, /\.profile-promo-row/);
  assert.match(css, /\.profile-promo-msg/);

  // app.js has function and export
  assert.match(app, /async function redeemProfilePromo/);
  assert.match(app, /window\.redeemProfilePromo\s*=\s*redeemProfilePromo/);
  assert.match(app, /fetch\("\/api\/user\/promo\/redeem"/);

  // paymentRoutes has endpoints
  assert.match(routes, /\/api\/user\/promo\/redeem/);
  assert.match(routes, /\/api\/pay\/promo\/redeem/);

  // server.js has admin endpoints
  assert.match(server, /\/api\/admin\/promos\/create/);

  // adminBot has gift_days parsing
  assert.match(bot, /gift_days/);
});
