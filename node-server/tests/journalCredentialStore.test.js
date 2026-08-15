"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createJournalCredentialStore } = require("../journalCredentialStore");

test("journal credentials survive restart and are never stored as plaintext", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-journal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "credentials.json");
  const secret = "test-secret-that-is-longer-than-thirty-two-characters";
  const first = createJournalCredentialStore({ filePath, secret });
  first.save("USR-1", "Binance", { apiKey: "public-key", apiSecret: "private-secret", passphrase: "" });

  const raw = fs.readFileSync(filePath, "utf8");
  assert.equal(raw.includes("public-key"), false);
  assert.equal(raw.includes("private-secret"), false);

  const restarted = createJournalCredentialStore({ filePath, secret });
  assert.deepEqual(restarted.get("USR-1", "BN"), { apiKey: "public-key", apiSecret: "private-secret", passphrase: "" });
  assert.deepEqual(restarted.list("USR-1").map(item => item.exchange), ["BN"]);
});

test("credentials are bound to a user and authenticated encryption context", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-journal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "credentials.json");
  const store = createJournalCredentialStore({ filePath, secret: "another-test-secret-that-is-definitely-long-enough" });
  store.save("USR-A", "OX", { apiKey: "key", apiSecret: "secret", passphrase: "pass" });
  assert.equal(store.get("USR-B", "OX"), null);
  assert.equal(store.remove("USR-A", "OX"), true);
  assert.equal(store.get("USR-A", "OX"), null);
});
