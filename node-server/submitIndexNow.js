"use strict";

const { SITE_ORIGIN, PAGES } = require("./seoPages");

const INDEXNOW_KEY = "d723e8aa468497a3709684a3756e6e46";

function createIndexNowPayload() {
  const origin = new URL(SITE_ORIGIN);
  return {
    host: origin.host,
    key: INDEXNOW_KEY,
    keyLocation: `${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`,
    urlList: [SITE_ORIGIN + "/", ...PAGES.map(page => SITE_ORIGIN + page.path)],
  };
}

async function submitIndexNow(fetchImpl = global.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchImpl("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(createIndexNowPayload()),
    signal: AbortSignal.timeout(15_000),
  });
  if (![200, 202].includes(response.status)) {
    throw new Error(`IndexNow rejected the submission with HTTP ${response.status}`);
  }
  return response.status;
}

if (require.main === module) {
  submitIndexNow()
    .then(status => console.log(`[INDEXNOW] Submitted ${createIndexNowPayload().urlList.length} URLs (HTTP ${status})`))
    .catch(error => {
      console.error(`[INDEXNOW] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { INDEXNOW_KEY, createIndexNowPayload, submitIndexNow };
