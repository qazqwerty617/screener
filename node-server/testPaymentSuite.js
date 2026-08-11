"use strict";

// Backward-compatible entry point. Security tests use isolated temporary data
// and mocked providers; they never create invoices in the production store.
const path = require("path");
const { spawnSync } = require("child_process");

const result = spawnSync(
  process.execPath,
  ["--test", path.join(__dirname, "tests", "paymentSecurity.test.js")],
  { stdio: "inherit" }
);

process.exitCode = typeof result.status === "number" ? result.status : 1;
