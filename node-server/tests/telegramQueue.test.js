"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// The queue reads the bot token from the environment at send time, so it must be
// present before the module is exercised.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";

const telegramQueue = require("../telegramQueue");

const realFetch = global.fetch;

function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    const method = String(url).split("/").pop();
    calls.push({ method, options });
    const body = await handler(method, calls.length, options);
    return { json: async () => body };
  };
  return calls;
}

test.afterEach(() => {
  global.fetch = realFetch;
});

test("a 429 is retried after retry_after instead of dropping the alert", async () => {
  const calls = stubFetch((method, n) => {
    if (n === 1) return { ok: false, error_code: 429, parameters: { retry_after: 0 } };
    return { ok: true, result: { message_id: 7 } };
  });

  const res = await telegramQueue.enqueue({ chatId: "111", text: "rate limited once" });

  assert.equal(res.ok, true, "message must be delivered after the rate-limit pause");
  assert.equal(calls.length, 2, "exactly one retry expected");
});

test("a permanent 403 fails fast without burning retries", async () => {
  const calls = stubFetch(() => ({ ok: false, error_code: 403, description: "bot was blocked by the user" }));

  const res = await telegramQueue.enqueue({ chatId: "222", text: "blocked user" });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "bot was blocked by the user");
  assert.equal(calls.length, 1, "a permanent rejection must not be retried");
});

test("a transient failure gives up after the attempt limit and reports failure", async () => {
  const calls = stubFetch(() => ({ ok: false, error_code: 500, description: "internal" }));

  const res = await telegramQueue.enqueue({ chatId: "333", text: "always failing" });

  assert.equal(res.ok, false, "caller must be able to see that delivery failed");
  assert.equal(calls.length, 3, "3 attempts then give up");
});

test("one chart upload is reused as file_id for the rest of the group", async () => {
  const calls = stubFetch((method, n, options) => {
    if (method === "sendPhoto" && options.body instanceof FormData) {
      return { ok: true, result: { photo: [{ file_id: "FILE-ABC" }] } };
    }
    return { ok: true, result: { message_id: n } };
  });

  const photo = Buffer.from("fake-png-bytes");
  const group = "grp-1";
  const first = await telegramQueue.enqueue({ chatId: "444", text: "chart", photoBuffer: photo, group });
  const second = await telegramQueue.enqueue({ chatId: "555", text: "chart", photoBuffer: photo, group });

  assert.equal(first.ok, true);
  assert.equal(first.fileId, "FILE-ABC");
  assert.equal(second.ok, true);

  const uploads = calls.filter(c => c.method === "sendPhoto" && c.options.body instanceof FormData);
  assert.equal(uploads.length, 1, "the second recipient must reuse the uploaded file_id");
});

test("enqueue rejects a missing chatId without touching the network", async () => {
  const calls = stubFetch(() => ({ ok: true }));

  const res = await telegramQueue.enqueue({ chatId: "", text: "nowhere" });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "MISSING_TARGET");
  assert.equal(calls.length, 0);
});
