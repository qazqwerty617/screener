"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const token = process.env.ADMIN_BOT_TOKEN;

async function pollWithFetch(timeoutSec = 20) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=${timeoutSec}`, {
      signal: AbortSignal.timeout((timeoutSec + 5) * 1000)
    });
    const data = await res.json();
    console.log(`Fetch poll finished in ${Date.now() - t0}ms: status=${res.status}, ok=${data.ok}, updates=${data.result?.length}`);
  } catch (err) {
    console.error(`Fetch poll error in ${Date.now() - t0}ms:`, err.message);
  }
}

(async () => {
  console.log("Testing 3 consecutive fetch polls with timeout=5s...");
  await pollWithFetch(5);
  await pollWithFetch(5);
  await pollWithFetch(5);
  console.log("All 3 fetch polls completed smoothly!");
})();
