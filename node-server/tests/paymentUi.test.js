"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "js", "app.js"), "utf8");

test("payment modal exposes promo validation and BEP20 selection", () => {
  assert.match(html, /id="pay-promo-input"/);
  assert.match(html, /id="pay-promo-apply"[^>]*onclick="applyPayPromo\(\);"/);
  assert.match(html, /id="pay-method-bep20"[^>]*onclick="selectPayMethod\('bep20'\);"/);
  assert.match(app, /fetch\("\/api\/pay\/promo\/validate"/);
  assert.match(app, /promoCode:\s*payAppliedPromoCode/);
  assert.match(app, /\["trc20", "bep20", "cryptobot"\]/);
});

test("invoice creation has a bounded client timeout and always restores its button", () => {
  const start = app.match(/async function startPayInvoice[\s\S]*?\n}\n\nfunction renderPayInvoiceStep/)?.[0] || "";
  assert.match(start, /AbortController/);
  assert.match(start, /setTimeout\(\(\) => controller\.abort\(\), 15_000\)/);
  assert.match(start, /finally\s*\{/);
  assert.match(start, /btn\.textContent = "Продолжить к оплате →"/);
});

test("guests cannot open payment modal or checkout without registering / logging in", () => {
  assert.match(html, /id="auth-notice-msg"/);
  assert.match(html, /id="auth-notice-text"/);
  assert.match(app, /function isUserLoggedIn\(\)/);
  assert.match(app, /window\.pendingPayAfterAuth/);

  // openPayModal must check isUserLoggedIn and redirect unauthenticated users to auth modal
  const openPay = app.match(/function openPayModal\(\)[\s\S]*?\n}\n\nasync function refreshAvailablePaymentMethods/)?.[0] || "";
  assert.match(openPay, /isUserLoggedIn/);
  assert.match(openPay, /openAuthModal\(/);
  assert.match(openPay, /pendingPayAfterAuth\s*=\s*true/);

  // startPayInvoice must guard against unauthenticated checkout
  const startPay = app.match(/async function startPayInvoice[\s\S]*?\n}\n\nfunction renderPayInvoiceStep/)?.[0] || "";
  assert.match(startPay, /isUserLoggedIn/);
  assert.match(startPay, /openAuthModal\(/);
});

test("tariff cards update dynamically with discount price and per-month rate when promo is applied", () => {
  const css = fs.readFileSync(path.join(root, "public", "css", "app.css"), "utf8");
  assert.match(css, /\.pay-t-old-price\s*\{/);
  assert.match(css, /\.pay-t-new-price\s*\{/);
  assert.match(css, /\.pay-t-desc-discounted\s*\{/);

  assert.match(app, /PAY_PLANS_INFO/);
  assert.match(app, /function updatePayTariffCards/);
  assert.match(app, /updatePayTariffCards\(data\.promo\)/);
  assert.match(app, /updatePayTariffCards\(null\)/);
  assert.match(app, /updatePayTariffCards\(payAppliedPromoData\)/);

  // Extract updatePayTariffCards and PAY_PLANS_INFO to test card mutations
  const snippet = app.match(/(const PAY_PLANS_INFO =[\s\S]*?function updatePayTariffCards[\s\S]*?\n})/)?.[0] || "";
  assert.ok(snippet, "updatePayTariffCards snippet found");

  const cards = [
    { plan: "1m", price: "$30", desc: "$30.00 / месяц" },
    { plan: "3m", price: "$80", desc: "$26.60 / месяц" },
    { plan: "12m", price: "$250", desc: "$20.80 / месяц" },
    { plan: "lifetime", price: "$490", desc: "Безлимитно и навсегда" }
  ].map(c => {
    const priceEl = { innerHTML: c.price, textContent: c.price };
    const descEl = { innerHTML: c.desc, textContent: c.desc };
    return {
      dataset: { plan: c.plan },
      querySelector: (sel) => sel === ".pay-t-price" ? priceEl : sel === ".pay-t-desc" ? descEl : null,
      _priceEl: priceEl,
      _descEl: descEl
    };
  });

  const mockDoc = {
    querySelectorAll: (sel) => sel === ".pay-tariff-card" ? cards : []
  };

  const fn = new Function("document", "paySelectedPlan", `${snippet}; return { PAY_PLANS_INFO, updatePayTariffCards };`);
  const { updatePayTariffCards } = fn(mockDoc, "1m");

  // Apply 50% discount promo
  updatePayTariffCards({ type: "percent", discountPercent: 50, amountStr: "15.00" });

  const card1m = cards.find(c => c.dataset.plan === "1m");
  assert.match(card1m._priceEl.innerHTML, /\$30/); // old price
  assert.match(card1m._priceEl.innerHTML, /\$15/); // new price
  assert.match(card1m._descEl.innerHTML, /\$15\.00 \/ месяц/); // per-month rate updated!

  const card3m = cards.find(c => c.dataset.plan === "3m");
  assert.match(card3m._priceEl.innerHTML, /\$80/);
  assert.match(card3m._priceEl.innerHTML, /\$40/);
  assert.match(card3m._descEl.innerHTML, /\$13\.33 \/ месяц/);

  const card12m = cards.find(c => c.dataset.plan === "12m");
  assert.match(card12m._priceEl.innerHTML, /\$250/);
  assert.match(card12m._priceEl.innerHTML, /\$125/);
  assert.match(card12m._descEl.innerHTML, /\$10\.42 \/ месяц/);

  // Revert promo
  updatePayTariffCards(null);
  assert.equal(card1m._priceEl.innerHTML, "$30");
  assert.equal(card1m._descEl.innerHTML, "$30.00 / месяц");
  assert.equal(card3m._priceEl.innerHTML, "$80");
  assert.equal(card3m._descEl.innerHTML, "$26.60 / месяц");
});


