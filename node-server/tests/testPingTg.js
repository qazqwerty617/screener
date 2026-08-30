"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const https = require("https");

const token = process.env.ADMIN_BOT_TOKEN;
console.log("Token configured:", !!token);

async function testFetch() {
  const t0 = Date.now();
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await res.json();
  console.log("Native fetch took:", Date.now() - t0, "ms", "User:", data.result?.username);
}

async function testHttpsGet() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    https.get(`https://api.telegram.org/bot${token}/getMe`, (res) => {
      let b = "";
      res.on("data", c => b += c);
      res.on("end", () => {
        const d = JSON.parse(b);
        console.log("https.get took:", Date.now() - t0, "ms", "User:", d.result?.username);
        resolve();
      });
    });
  });
}

(async () => {
  await testFetch();
  await testFetch();
  await testHttpsGet();
  await testHttpsGet();
})().catch(console.error);
