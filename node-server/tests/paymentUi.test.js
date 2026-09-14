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
