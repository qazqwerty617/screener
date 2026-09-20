"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const shield = require("../securityShield");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const USER_STORE = fs.readFileSync(path.join(__dirname, "..", "userStore.js"), "utf8");
const CLIENT = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
const JOURNAL = fs.readFileSync(path.join(__dirname, "..", "public", "js", "journal.js"), "utf8");

test("firewall inputs accept only IP addresses", () => {
  assert.equal(shield.normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(shield.normalizeIp("2001:db8::1"), "2001:db8::1");
  assert.equal(shield.normalizeIp("203.0.113.9; touch /tmp/pwned"), "");
  assert.equal(shield.banIp("203.0.113.9; touch /tmp/pwned"), false);
});

test("Telegram destinations are bound to the authenticated account", () => {
  assert.match(SERVER, /const user = userStore\.getUserByToken\(getBearerToken\(req\), \{ ip: req\.ip \}\);/);
  assert.match(SERVER, /if \(requestedChatId && requestedChatId !== chatId\)/);
  assert.doesNotMatch(SERVER, /const \{ message, botToken \} = req\.body/);
  assert.match(SERVER, /const isUserAdmin = Boolean\(adminChatId && user\.telegramLinked && String\(user\.telegramId \|\| ""\) === adminChatId\)/);
  assert.match(USER_STORE, /return Boolean\(strId && users\[userId\]\.telegramChatId === strId\);/);
});

test("client rendering does not interpolate an avatar URL into HTML", () => {
  assert.doesNotMatch(CLIENT, /profileAvatar\.innerHTML\s*=/);
  assert.match(CLIENT, /profileAvatar\.replaceChildren\(avatar\)/);
});

test("journal template escapes stored and exchange-provided trade fields", () => {
  assert.match(JOURNAL, /function escapeHtml\(value\)/);
  assert.match(JOURNAL, /\$\{escapeHtml\(t\.note \|\| "—"\)\}/);
  assert.match(JOURNAL, /data-trade-id="\$\{escapeHtml\(t\.id\)\}"/);
  assert.match(JOURNAL, /\$\{escapeHtml\(t\.symbol\)\}/);
});
