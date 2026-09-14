"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPaymentGateway, PaymentError } = require("../paymentGateway");
const { getBearerToken } = require("../paymentRoutes");

const TEST_WALLET = "TJeoZg35n1k11zLuLSuhbPZGiiqF2PmBN9";
const TEST_BEP20_WALLET = "0xe0b42e5c4fa2170bb347074ec6f96fec600ef84b";

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(value); }
  };
}

function createUserStore() {
  const grants = [];
  const applied = new Set();
  return {
    grants,
    findUser(id) {
      if (!/^USR-[A-Z0-9]+$/.test(String(id))) return null;
      return { id, username: `user-${id}` };
    },
    grantPlanForPayment(userId, paymentKey, days) {
      const key = `${userId}:${paymentKey}`;
      const wasApplied = applied.has(key);
      if (!wasApplied) {
        applied.add(key);
        grants.push({ userId, paymentKey, days });
      }
      return { user: { id: userId, username: `user-${userId}` }, applied: !wasApplied };
    }
  };
}

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-payment-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("payment methods fail closed when their server configuration is absent", async t => {
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: {},
    userStore: createUserStore(),
    fetchImpl: async () => { throw new Error("unexpected network request"); },
    startCleanupTimer: false,
    notifyPayment: false
  });
  assert.deepEqual(gateway.getAvailableMethods(), ["bep20"]);
  await assert.rejects(
    gateway.createInvoice("USR-A", "1m", "trc20"),
    error => error instanceof PaymentError && error.code === "METHOD_UNAVAILABLE"
  );
});

test("amount parsing rejects exponent notation and excess precision", t => {
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: {},
    userStore: createUserStore(),
    fetchImpl: async () => jsonResponse({}),
    startCleanupTimer: false,
    notifyPayment: false
  });
  assert.equal(gateway._test.decimalToMinor("30.00"), 3000);
  assert.equal(gateway._test.decimalToMinor("30"), 3000);
  assert.equal(gateway._test.decimalToMinor("3e1"), null);
  assert.equal(gateway._test.decimalToMinor("30.001"), null);
  assert.equal(gateway._test.decimalToMinor("-30"), null);
});

test("TRC20 invoices are private, persistent, unpredictable and owner-bound", async t => {
  const dir = createTempDir(t);
  const store = createUserStore();
  const options = {
    dataDir: dir,
    env: { PAYMENT_TRC20_WALLET: TEST_WALLET },
    userStore: store,
    fetchImpl: async () => jsonResponse({ data: [] }),
    startCleanupTimer: false,
    notifyPayment: false
  };
  const firstGateway = createPaymentGateway(options);
  const invoice = await firstGateway.createInvoice("USR-A", "1m", "trc20");
  assert.match(invoice.id, /^inv_[A-Za-z0-9_-]{32}$/);
  assert.equal(invoice.amountStr, "30.01");
  assert.equal(invoice.address, TEST_WALLET);
  assert.equal(Object.hasOwn(invoice, "userId"), false);
  assert.equal(Object.hasOwn(invoice, "reservationKey"), false);

  await assert.rejects(
    firstGateway.getInvoiceStatus(invoice.id, "USR-B"),
    error => error.code === "INVOICE_NOT_FOUND" && error.status === 404
  );
  await assert.rejects(
    firstGateway.createInvoice("USR-A", "3m", "trc20"),
    error => error.code === "ACTIVE_INVOICE_EXISTS" && error.status === 409
  );

  const restartedGateway = createPaymentGateway(options);
  const restored = await restartedGateway.createInvoice("USR-A", "1m", "trc20");
  assert.equal(restored.id, invoice.id);
});

test("an owner can explicitly replace an unpaid active invoice", async t => {
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: { PAYMENT_TRC20_WALLET: TEST_WALLET },
    userStore: createUserStore(),
    fetchImpl: async () => jsonResponse({ data: [] }),
    startCleanupTimer: false,
    notifyPayment: false
  });

  const first = await gateway.createInvoice("USR-A", "1m", "trc20");
  const replacement = await gateway.createInvoice("USR-A", "3m", "trc20", { replaceActive: true });

  assert.notEqual(replacement.id, first.id);
  assert.equal(replacement.planId, "3m");
  assert.equal(gateway._test.getInvoice(first.id).status, "cancelled");
  assert.equal(gateway._test.getInvoice(replacement.id).status, "pending");
});

test("TRC20 grants only for confirmed exact USDT contract transfer in the invoice window", async t => {
  const store = createUserStore();
  let requestUrl = "";
  let transaction = null;
  const now = Date.now();
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: { PAYMENT_TRC20_WALLET: TEST_WALLET, TRONGRID_API_KEY: "test-key" },
    userStore: store,
    now: () => now,
    fetchImpl: async (url, options) => {
      requestUrl = String(url);
      assert.equal(options.headers["TRON-PRO-API-KEY"], "test-key");
      return jsonResponse({ data: transaction ? [transaction] : [] });
    },
    startCleanupTimer: false,
    notifyPayment: false
  });
  const invoice = await gateway.createInvoice("USR-TRON", "1m", "trc20");
  const internal = gateway._test.getInvoice(invoice.id);
  transaction = {
    transaction_id: "a".repeat(64),
    to: TEST_WALLET,
    type: "Transfer",
    block_timestamp: now + 30_000,
    value: String(BigInt(internal.amountMinor) * 10_000n),
    token_info: {
      address: TRC20_USDT_CONTRACT_FOR_TEST(),
      symbol: "USDT",
      decimals: 6
    }
  };
  const result = await gateway.getInvoiceStatus(invoice.id, "USR-TRON");
  assert.equal(result.status, "success");
  assert.equal(store.grants.length, 1);
  assert.match(requestUrl, /only_confirmed=true/);
  assert.match(requestUrl, /contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/);

  const replay = await gateway.getInvoiceStatus(invoice.id, "USR-TRON");
  assert.equal(replay.status, "success");
  assert.equal(store.grants.length, 1);
});

test("TRC20 rejects a lookalike token and an old transfer", async t => {
  const store = createUserStore();
  const now = Date.now();
  let transactions = [];
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: { PAYMENT_TRC20_WALLET: TEST_WALLET },
    userStore: store,
    now: () => now,
    fetchImpl: async () => jsonResponse({ data: transactions }),
    startCleanupTimer: false,
    notifyPayment: false
  });
  const invoice = await gateway.createInvoice("USR-REJECT", "3m", "trc20");
  const internal = gateway._test.getInvoice(invoice.id);
  const base = {
    transaction_id: "b".repeat(64),
    to: TEST_WALLET,
    type: "Transfer",
    value: String(BigInt(internal.amountMinor) * 10_000n),
    token_info: { address: "TFakeToken11111111111111111111111111", symbol: "USDT", decimals: 6 }
  };
  transactions = [{ ...base, block_timestamp: now + 10_000 }];
  assert.equal((await gateway.getInvoiceStatus(invoice.id, "USR-REJECT")).status, "pending");
  internal.nextVerificationAt = 0;
  transactions = [{
    ...base,
    transaction_id: "c".repeat(64),
    block_timestamp: now - 60_000,
    token_info: { address: TRC20_USDT_CONTRACT_FOR_TEST(), symbol: "USDT", decimals: 6 }
  }];
  assert.equal((await gateway.getInvoiceStatus(invoice.id, "USR-REJECT")).status, "pending");
  assert.equal(store.grants.length, 0);
});

test("restart recovery verifies an expired-window invoice before expiring it", async t => {
  const dir = createTempDir(t);
  const store = createUserStore();
  const createdAt = Date.now();
  let now = createdAt;
  let transaction = null;
  const options = {
    dataDir: dir,
    env: { PAYMENT_TRC20_WALLET: TEST_WALLET },
    userStore: store,
    now: () => now,
    fetchImpl: async () => jsonResponse({ data: transaction ? [transaction] : [] }),
    startCleanupTimer: false,
    notifyPayment: false
  };
  const beforeRestart = createPaymentGateway(options);
  const invoice = await beforeRestart.createInvoice("USR-RECOVERY", "1m", "trc20");
  const expectedMinor = beforeRestart._test.getInvoice(invoice.id).amountMinor;

  now = createdAt + 55 * 60 * 1000;
  transaction = {
    transaction_id: "d".repeat(64),
    to: TEST_WALLET,
    type: "Transfer",
    block_timestamp: createdAt + 10 * 60 * 1000,
    value: String(BigInt(expectedMinor) * 10_000n),
    token_info: { address: TRC20_USDT_CONTRACT_FOR_TEST(), symbol: "USDT", decimals: 6 }
  };
  const afterRestart = createPaymentGateway(options);
  const recovered = await afterRestart.getInvoiceStatus(invoice.id, "USR-RECOVERY");
  assert.equal(recovered.status, "success");
  assert.equal(store.grants.length, 1);
});

test("provider outage never converts an unverified invoice to expired", async t => {
  const createdAt = Date.now();
  let now = createdAt;
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: { PAYMENT_TRC20_WALLET: TEST_WALLET },
    userStore: createUserStore(),
    now: () => now,
    fetchImpl: async () => { throw new Error("network unavailable"); },
    startCleanupTimer: false,
    notifyPayment: false
  });
  const invoice = await gateway.createInvoice("USR-OUTAGE", "1m", "trc20");
  now = createdAt + 55 * 60 * 1000;
  await gateway._test.reconcileExpiredInvoices();
  assert.equal(gateway._test.getInvoice(invoice.id).status, "pending");
});

test("Crypto Pay webhook requires HMAC and re-fetches the paid invoice server-side", async t => {
  const token = "123456789:TEST_CRYPTO_PAY_TOKEN_THAT_IS_LONG";
  const webhookSecret = "w".repeat(48);
  const store = createUserStore();
  let localInvoiceId = "";
  let getInvoicesCalls = 0;
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: {
      CRYPTO_PAY_API_TOKEN: token,
      CRYPTO_PAY_WEBHOOK_SECRET: webhookSecret,
      CRYPTO_PAY_TESTNET: "true"
    },
    userStore: store,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).endsWith("/createInvoice")) {
        localInvoiceId = body.payload;
        return jsonResponse({
          ok: true,
          result: { invoice_id: 777, bot_invoice_url: "https://t.me/CryptoTestnetBot?start=invoice-777" }
        });
      }
      if (String(url).endsWith("/getInvoices")) {
        getInvoicesCalls++;
        assert.equal(body.invoice_ids, "777");
        return jsonResponse({
          ok: true,
          result: {
            items: [{
              invoice_id: 777,
              status: "paid",
              payload: localInvoiceId,
              asset: "USDT",
              amount: "30.00",
              paid_at: new Date().toISOString()
            }]
          }
        });
      }
      throw new Error("unexpected Crypto Pay method");
    },
    startCleanupTimer: false,
    notifyPayment: false
  });

  const invoice = await gateway.createInvoice("USR-CRYPTO", "1m", "cryptobot");
  assert.equal(gateway.verifyWebhookPathSecret(webhookSecret), true);
  assert.equal(gateway.verifyWebhookPathSecret("wrong"), false);

  const update = Buffer.from(JSON.stringify({
    update_id: 1,
    update_type: "invoice_paid",
    request_date: new Date().toISOString(),
    // The webhook amount is deliberately forged; fulfillment must use getInvoices.
    payload: { invoice_id: 777, payload: invoice.id, asset: "USDT", amount: "0.01" }
  }));
  const secret = crypto.createHash("sha256").update(token).digest();
  const signature = crypto.createHmac("sha256", secret).update(update).digest("hex");

  await assert.rejects(
    gateway.handleCryptoBotWebhook(update, "0".repeat(64)),
    error => error.code === "INVALID_WEBHOOK_SIGNATURE"
  );
  const handled = await gateway.handleCryptoBotWebhook(update, signature);
  assert.equal(handled.processed, true);
  assert.equal(getInvoicesCalls, 1);
  assert.equal(store.grants.length, 1);

  await gateway.handleCryptoBotWebhook(update, signature);
  assert.equal(store.grants.length, 1);
});

test("percentage promos change the server-side price and are consumed only after payment", async t => {
  const dir = createTempDir(t);
  const promosFile = path.join(dir, "promos.json");
  fs.writeFileSync(promosFile, JSON.stringify([{
    code: "SAVE25", type: "percent", value: 25, active: true, usedCount: 0, limit: 2,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  }]));
  const store = createUserStore();
  const now = Date.now();
  let transaction = null;
  const gateway = createPaymentGateway({
    dataDir: dir,
    promosFile,
    env: { PAYMENT_TRC20_WALLET: TEST_WALLET },
    userStore: store,
    now: () => now,
    fetchImpl: async () => jsonResponse({ data: transaction ? [transaction] : [] }),
    startCleanupTimer: false,
    notifyPayment: false
  });

  const quote = gateway.getPromoQuote("save25", "1m", "USR-PROMO");
  assert.deepEqual(quote, {
    code: "SAVE25", type: "percent", value: 25, originalAmountStr: "30.00",
    amountStr: "22.50", discountPercent: 25, bonusDays: 0, totalDays: 30
  });
  const invoice = await gateway.createInvoice("USR-PROMO", "1m", "trc20", { promoCode: "save25" });
  assert.equal(invoice.amountStr, "22.51");
  assert.equal(invoice.promo.code, "SAVE25");
  assert.equal(JSON.parse(fs.readFileSync(promosFile, "utf8"))[0].usedCount, 0);

  const internal = gateway._test.getInvoice(invoice.id);
  transaction = {
    transaction_id: "e".repeat(64), to: TEST_WALLET, type: "Transfer",
    block_timestamp: now + 10_000,
    value: String(BigInt(internal.amountMinor) * 10_000n),
    token_info: { address: TRC20_USDT_CONTRACT_FOR_TEST(), symbol: "USDT", decimals: 6 }
  };
  assert.equal((await gateway.getInvoiceStatus(invoice.id, "USR-PROMO")).status, "success");
  const savedPromo = JSON.parse(fs.readFileSync(promosFile, "utf8"))[0];
  assert.equal(savedPromo.usedCount, 1);
  assert.deepEqual(store.grants[0], { userId: "USR-PROMO", paymentKey: `invoice:${invoice.id}`, days: 30 });
});

test("day promos keep the price and extend the granted subscription", async t => {
  const dir = createTempDir(t);
  const promosFile = path.join(dir, "promos.json");
  fs.writeFileSync(promosFile, JSON.stringify([{
    code: "BONUS7", type: "days", value: 7, active: true, usedCount: 0, limit: 10,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  }]));
  const store = createUserStore();
  let localInvoiceId = "";
  const gateway = createPaymentGateway({
    dataDir: dir,
    promosFile,
    env: { CRYPTO_PAY_API_TOKEN: "test-token", CRYPTO_PAY_WEBHOOK_SECRET: "s".repeat(40) },
    userStore: store,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).endsWith("/createInvoice")) {
        localInvoiceId = body.payload;
        assert.equal(body.amount, "30.00");
        return jsonResponse({ ok: true, result: { invoice_id: 901, bot_invoice_url: "https://t.me/CryptoBot?start=901" } });
      }
      if (String(url).endsWith("/getInvoices")) {
        return jsonResponse({ ok: true, result: { items: [{ invoice_id: 901, status: "paid", payload: localInvoiceId, asset: "USDT", amount: "30.00" }] } });
      }
      throw new Error("unexpected method");
    },
    startCleanupTimer: false,
    notifyPayment: false
  });
  const invoice = await gateway.createInvoice("USR-BONUS", "1m", "cryptobot", { promoCode: "bonus7" });
  assert.equal(invoice.promo.bonusDays, 7);
  assert.equal((await gateway.getInvoiceStatus(invoice.id, "USR-BONUS")).status, "success");
  assert.equal(store.grants[0].days, 37);
});

test("BEP20 verifies exact official-token transfer on BSC with finality", async t => {
  const now = Date.now();
  const store = createUserStore();
  let expectedRaw = null;
  let blockNumberCalls = 0;
  const calls = [];
  const gateway = createPaymentGateway({
    dataDir: createTempDir(t),
    env: { PAYMENT_BEP20_WALLET: TEST_BEP20_WALLET, BSC_RPC_URL: "https://bsc.test.invalid" },
    userStore: store,
    now: () => now,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      if (request.method === "eth_chainId") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: "0x38" });
      if (request.method === "eth_blockNumber") {
        blockNumberCalls++;
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: blockNumberCalls === 1 ? "0x3e8" : "0x3f7" });
      }
      if (request.method === "eth_getLogs") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: [{
        address: "0x55d398326f99059ff775485246999027b3197955",
        blockNumber: "0x3e8", transactionHash: `0x${"f".repeat(64)}`, removed: false,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          `0x${"0".repeat(24)}${"1".repeat(40)}`,
          `0x${"0".repeat(24)}${TEST_BEP20_WALLET.slice(2)}`
        ],
        data: `0x${expectedRaw.toString(16).padStart(64, "0")}`
      }] });
      if (request.method === "eth_getBlockByNumber") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { timestamp: `0x${Math.floor((now + 10_000) / 1000).toString(16)}` } });
      if (request.method === "eth_getTransactionReceipt") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { status: "0x1", blockNumber: "0x3e8" } });
      throw new Error(`unexpected RPC method ${request.method}`);
    },
    startCleanupTimer: false,
    notifyPayment: false
  });
  const invoice = await gateway.createInvoice("USR-BSC", "1m", "bep20");
  const internal = gateway._test.getInvoice(invoice.id);
  expectedRaw = BigInt(internal.amountMinor) * 10_000_000_000_000_000n;
  assert.equal(invoice.address, TEST_BEP20_WALLET);
  assert.equal((await gateway.getInvoiceStatus(invoice.id, "USR-BSC")).status, "success");
  assert.equal(store.grants.length, 1);
  const logCall = calls.find(call => call.method === "eth_getLogs");
  assert.equal(logCall.params[0].address, "0x55d398326f99059ff775485246999027b3197955");
  assert.equal(logCall.params[0].toBlock, "0x3e8");
});

test("Bearer parser accepts only a strict Authorization header", () => {
  const token = "A".repeat(43);
  assert.equal(getBearerToken({ headers: { authorization: `Bearer ${token}` } }), token);
  assert.equal(getBearerToken({ headers: { authorization: `Basic ${token}` } }), "");
  assert.equal(getBearerToken({ headers: { authorization: `Bearer ${token} extra` } }), "");
  assert.equal(getBearerToken({ headers: {} }), "");
});

function TRC20_USDT_CONTRACT_FOR_TEST() {
  return "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
}
