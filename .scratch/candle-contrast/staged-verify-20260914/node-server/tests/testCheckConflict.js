"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const userToken = process.env.TELEGRAM_BOT_TOKEN;
const adminToken = process.env.ADMIN_BOT_TOKEN;

async function checkToken(name, token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`);
    const data = await res.json();
    console.log(`[${name}] Status: ${res.status}, ok: ${data.ok}, error_code: ${data.error_code}, desc: ${data.description}`);
  } catch (err) {
    console.error(`[${name}] Fetch error:`, err.message);
  }
}

(async () => {
  await checkToken("USER BOT", userToken);
  await checkToken("ADMIN BOT", adminToken);
})();
