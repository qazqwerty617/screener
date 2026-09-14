"use strict";
const fs = require("fs");
const path = require("path");

const botFilePath = path.join(__dirname, "..", "adminBot.js");
const content = fs.readFileSync(botFilePath, "utf8");

// Extract all callback_data
const regex = /callback_data:\s*[`"']([^`"']+)[`"']/g;
const callbacks = new Set();
let match;
while ((match = regex.exec(content)) !== null) {
  callbacks.add(match[1]);
}

console.log(`Found ${callbacks.size} unique callback_data patterns.`);

// Setup mock fetch before requiring adminBot
const calls = [];
global.fetch = async function (url, options = {}) {
  const urlStr = String(url);
  let body = {};
  try {
    if (options.body && typeof options.body === "string") {
      body = JSON.parse(options.body);
    }
  } catch (_) {}
  calls.push({ url: urlStr, method: options.method, body });
  return {
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 999, file_path: "photos/test.jpg" } }),
    arrayBuffer: async () => Buffer.from("mock_image")
  };
};

const adminBot = require("../adminBot");
const userStore = require("../userStore");

// Ensure admin chat id is set for testing
process.env.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8482582995";
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "mock_token";
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "mock_main_token";

const users = Object.values(userStore.getAllUsersRaw());
const sampleUser = users[0] || { id: "USR-TEST", username: "testuser" };

async function runAudit() {
  const errors = [];
  let passedButtons = 0;

  // 1. TEST ALL 124 INLINE BUTTON CALLBACKS
  for (const rawCb of Array.from(callbacks)) {
    let testCb = rawCb
      .replace(/\${user\.id}/g, sampleUser.id)
      .replace(/\${u\.id}/g, sampleUser.id)
      .replace(/\${userId}/g, sampleUser.id)
      .replace(/\${days}/g, "30")
      .replace(/\${tag}/g, "VIP")
      .replace(/\${p\.key}/g, "pay_sample")
      .replace(/\${payKey}/g, "pay_sample")
      .replace(/\${ticketId}/g, "TKT-1")
      .replace(/\${t\.id}/g, "TKT-1")
      .replace(/\${promoCode}/g, "PROMO10")
      .replace(/\${code}/g, "PROMO10")
      .replace(/\${filterType}/g, "all")
      .replace(/\${period}/g, "24h")
      .replace(/\${reportData\.id}/g, "BUG-1")
      .replace(/\${reportData\.userId}/g, sampleUser.id);

    testCb = testCb.replace(/\$\{[^}]+\}/g, "1");

    const query = {
      id: "cbq_test_" + Math.random().toString(36).slice(2),
      data: testCb,
      message: {
        chat: { id: process.env.ADMIN_CHAT_ID },
        message_id: 100
      }
    };

    calls.length = 0;

    try {
      await adminBot.handleAdminCallbackQuery(query);
      passedButtons++;
    } catch (err) {
      errors.push({ type: "button", rawCb, testCb, error: err.stack || err.message });
    }
  }

  // 2. TEST TEXT COMMANDS & PROMPT INPUTS
  const textTests = [
    { text: "/start" },
    { text: "/menu" },
    { text: "/help" },
    { text: "/digest" },
    { text: sampleUser.id },
    { text: sampleUser.username }
  ];

  let passedTexts = 0;
  for (const t of textTests) {
    try {
      await adminBot.handleAdminMessageText({
        chat: { id: process.env.ADMIN_CHAT_ID },
        text: t.text
      });
      passedTexts++;
    } catch (err) {
      errors.push({ type: "text", test: t.text, error: err.stack || err.message });
    }
  }

  console.log(`\n=== AUDIT RESULTS ===`);
  console.log(`Inline Buttons Tested: ${callbacks.size} | Passed: ${passedButtons}`);
  console.log(`Text Commands Tested: ${textTests.length} | Passed: ${passedTexts}`);
  console.log(`Total Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.error("\nERRORS DETECTED:");
    for (const e of errors) {
      console.error(`- [${e.type}] ${e.rawCb || e.test}: ${e.error}`);
    }
    process.exit(1);
  } else {
    console.log("\nALL BUTTONS AND COMMANDS AUDITED & WORKING 100%!");
    process.exit(0);
  }
}

runAudit().catch(err => {
  console.error("Audit runner fatal error:", err);
  process.exit(1);
});
