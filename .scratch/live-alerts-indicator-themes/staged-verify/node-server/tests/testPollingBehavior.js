"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const https = require("https");

const token = process.env.ADMIN_BOT_TOKEN;

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 8
});

function pollOnce() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=0&timeout=10`;
    console.log("Starting poll request with timeout: 15000...");
    const req = https.get(url, { agent, timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        console.log(`Poll finished with status ${res.statusCode} in ${Date.now() - t0}ms, len: ${body.length}`);
        resolve();
      });
    });
    req.on("socket", s => s.setKeepAlive(true, 10000));
    req.on("error", err => {
      console.error(`Poll error in ${Date.now() - t0}ms:`, err.message);
      reject(err);
    });
    req.on("timeout", () => {
      console.warn(`Socket timeout event fired after ${Date.now() - t0}ms! Destroying socket.`);
      req.destroy();
    });
  });
}

(async () => {
  try {
    await pollOnce();
    await pollOnce();
  } catch (e) {
    console.error("Caught:", e.message);
  }
})();
