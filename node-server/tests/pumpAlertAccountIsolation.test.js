"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "alertEngine.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(ROOT, "public", "js", "app.js"), "utf8");
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

test("server.js defines sendUserAlert targeting specific user WebSocket connections", () => {
  assert.match(SERVER_SRC, /function sendUserAlert\(userId,\s*type,\s*data\)/);
  assert.match(SERVER_SRC, /ws\._userId === userId/);
  assert.match(SERVER_SRC, /sendUserAlert:\s*\(userId,\s*type,\s*data\)\s*=>\s*sendUserAlert\(userId,\s*type,\s*data\)/);
});

test("alertEngine isolates subscribers and prevents cross-subscriber pollution", () => {
  // Must NOT declare shared loop variables that contaminate subscribers
  assert.doesNotMatch(ENGINE_SRC, /let minPeriodMins = 5;\s*let detectedPctChange = 0;/);
  
  // Matching subscriber entries store their own parameters
  assert.match(ENGINE_SRC, /matchingSubs\.push\(\{[\s\S]*?pastPrice:\s*analysis\.referencePrice,[\s\S]*?quality:\s*analysis\.quality[\s\S]*?\}\);/);

  // Telegram dispatch loops through matchingSubs using each entry's own period and pctChange
  assert.match(ENGINE_SRC, /• <b>Период:<\/b> \$\{entryPeriodMins\} мин/);
  assert.match(ENGINE_SRC, /\[\$\{entrySign\}\$\{entryPctChange\.toFixed\(2\)\}%\]/);
  assert.doesNotMatch(ENGINE_SRC, /Качество импульса/,
    "Telegram pump/dump messages must not expose the internal quality score");

  // GroupToken incorporates entryPeriodMins so Telegram alerts don't conflict across periods
  assert.match(ENGINE_SRC, /const groupToken = `pd:\$\{t\.key\}:\$\{entryIsPump \? "pump" : "dump"\}:\$\{entryPeriodMins\}:\$\{now\}`;/);
});

test("alertEngine sends targeted WebSocket alerts with targetUserId and user's period", () => {
  assert.match(ENGINE_SRC, /targetUserId:\s*entry\.sub\.userId/);
  assert.match(ENGINE_SRC, /bars:\s*entry\.periodMins/);
  assert.match(ENGINE_SRC, /sendUserAlertFn\(entry\.sub\.userId,\s*"pump_dump_alert",\s*userAlertData\)/);
});

test("alertEngine global WebSocket broadcast is strictly benchmark 5m and does not bleed subscriber settings", () => {
  const wsBlock = ENGINE_SRC.slice(
    ENGINE_SRC.indexOf("// Public real-time feed uses the same path-quality"),
    ENGINE_SRC.indexOf("if (matchingSubs.length === 0) return;")
  );
  assert.match(wsBlock, /bars:\s*5/);
  assert.match(wsBlock, /const wsPct = wsAnalysis\.pct;/);
  assert.doesNotMatch(wsBlock, /matchingSubs\.length > 0 \? detectedPctChange : defaultPctChange/);
});

test("app.js enforces targetUserId and period/timeframe matching on server push alerts", () => {
  const handlerStart = APP_SRC.indexOf("window.handleServerPumpDumpAlert = function");
  assert.ok(handlerStart > 0);
  const handlerBody = APP_SRC.slice(handlerStart, APP_SRC.indexOf("pdFireAlert({", handlerStart));
  
  // Account isolation check
  assert.match(handlerBody, /if \(data\.targetUserId && data\.targetUserId !== curUserId\) return;/);

  // Timeframe / period check
  assert.match(handlerBody, /const userBars = Math\.max\(1, Math\.round\(pdSettings\.periodMinutes \|\| 5\)\);/);
  assert.match(handlerBody, /const alertBars = Math\.max\(1, Math\.round\(data\.bars \|\| 5\)\);/);
  assert.match(handlerBody, /if \(alertBars !== userBars\) return;/);
  assert.match(handlerBody, /if \(!pdIsExchangeAllowed\(data\.ex\)\) return;/);
  assert.match(APP_SRC, /function pdFireAlert\([^)]*\) \{\s*\/\/[\s\S]*?if \(!pdIsExchangeAllowed\(ex\)\) return;/);
});

test("app.js applies one symbol cooldown across pump and dump delivery paths", () => {
  assert.match(APP_SRC, /new pdLogic\.SignalCooldownGate\(/);
  const fireStart = APP_SRC.indexOf("function pdFireAlert");
  const fireEnd = APP_SRC.indexOf("// ── Alert Card Panel", fireStart);
  const fireBody = APP_SRC.slice(fireStart, fireEnd);
  assert.match(fireBody, /pdSignalCooldownGate\.allow\(/);
  assert.match(fireBody, /oppositeDirectionMs:\s*180_000/);
  assert.doesNotMatch(fireBody, /const cooldownKey = `\$\{ex\}:\$\{sym\}:\$\{isPump/);
});

test("the live detector reads volume from the ticker instead of an undefined variable", () => {
  const start = APP_SRC.indexOf("function pdCheckLiveTick");
  const end = APP_SRC.indexOf("window.pdTrackPrice", start);
  const block = APP_SRC.slice(start, end);
  assert.match(block, /const coin = window\.coins/);
  assert.doesNotMatch(block, /\bc\s*&&\s*c\.v\b/);
});

test("app.js scopes localStorage by user ID to prevent cross-account settings overwrite", () => {
  assert.match(APP_SRC, /function pdGetStorageKey\(\)/);
  assert.match(APP_SRC, /`obsidian_pump_alert_settings_\$\{userId\}`/);
});

test("the pump settings UI uses ALL as a mode and delegates exchange toggling to PumpLogic", () => {
  assert.match(APP_SRC, /pdLogic\.toggleExchangeSelection\(draft\.exchanges, ex\)/);
  assert.doesNotMatch(APP_SRC, /draft\.exchanges = \["all", "BN", "BB", "OX"/);
});

test("functional: alertEngine processes ticks and delivers distinct messages to distinct subscribers", async () => {
  delete require.cache[require.resolve("../alertEngine")];
  const alertEngine = require("../alertEngine");

  const sentTelegram = [];
  const fakeTelegramBot = {
    sendAlert: async (chatId, text, photo, opts, group) => {
      sentTelegram.push({ chatId, text, group });
      return { ok: true };
    }
  };

  const targetedWsAlerts = [];
  const fakeSendUserAlert = (userId, type, data) => {
    targetedWsAlerts.push({ userId, type, data });
  };

  const globalWsAlerts = [];
  const fakeBroadcastAlert = (type, data) => {
    globalWsAlerts.push({ type, data });
  };

  const mockUsers = {
    "user-1": {
      id: "user-1",
      telegramChatId: "tg-101",
      preferences: {
        notifications: {
          tgEnabled: true,
          pumpDump: {
            enabled: true,
            periodMinutes: 1,
            minPct: 1.5,
            minVolume: 1000,
            direction: "pump",
            marketType: "both",
            exchanges: ["all"],
            cooldownSeconds: 60
          }
        }
      }
    },
    "user-2": {
      id: "user-2",
      telegramChatId: "tg-202",
      preferences: {
        notifications: {
          tgEnabled: true,
          pumpDump: {
            enabled: true,
            periodMinutes: 15,
            minPct: 4.0,
            minVolume: 1000,
            direction: "pump",
            marketType: "both",
            exchanges: ["all"],
            cooldownSeconds: 60
          }
        }
      }
    }
  };

  const mockUserStore = {
    getAllUsers: () => mockUsers,
    getAllUsersRaw: () => mockUsers
  };

  const tickers = new Map();
  tickers.set("BN:TESTUSDT", {
    key: "BN:TESTUSDT",
    p: 100,
    v: 5000000
  });

  const mockCandles = Array.from({ length: 15 }, (_, i) => ({
    t: Date.now() - (15 - i) * 60000,
    o: 95,
    h: 100,
    l: 95,
    c: 100,
    v: 1000
  }));

  alertEngine.init({
    tickers,
    telegramBot: fakeTelegramBot,
    userStore: mockUserStore,
    fetchCandles: async () => mockCandles,
    sendUserAlert: fakeSendUserAlert,
    broadcastAlert: fakeBroadcastAlert
  });

  try {
    const now = Date.now();
    // Simulate price history:
    // 15 mins ago: price was 90
    // 1 min ago: price was 95
    // Now: price is 100 (5.26% jump in 1m; 11.11% jump in 15m)
    alertEngine.priceHistory.push("BN:TESTUSDT", now - 15 * 60 * 1000, 90);
    alertEngine.priceHistory.push("BN:TESTUSDT", now - 1 * 60 * 1000, 95);
    alertEngine.priceHistory.push("BN:TESTUSDT", now - 30 * 1000, 97.5);

    alertEngine.processTicker({
      key: "BN:TESTUSDT",
      p: 100,
      v: 5000000
    }, now);

    // Wait for async chart rendering and dispatch
    const startWait = Date.now();
    while (sentTelegram.length < 2 && Date.now() - startWait < 5000) {
      await new Promise(r => setTimeout(r, 50));
    }

    // Verify both subscribers received their own tailored alert
    assert.equal(sentTelegram.length, 2, "Both subscribers should receive telegram alerts");

    const sub1Alert = sentTelegram.find(s => s.chatId === "tg-101");
    const sub2Alert = sentTelegram.find(s => s.chatId === "tg-202");

    assert.ok(sub1Alert, "User 1 should receive alert");
    assert.ok(sub2Alert, "User 2 should receive alert");

    assert.match(sub1Alert.text, /Период:<\/b> 1 мин/, "User 1 message must specify 1 minute period");
    assert.match(sub1Alert.text, /\+5\.26%/, "User 1 message must specify 5.26% change");

    assert.match(sub2Alert.text, /Период:<\/b> 15 мин/, "User 2 message must specify 15 minute period");
    assert.match(sub2Alert.text, /\+11\.11%/, "User 2 message must specify 11.11% change");

    // Verify targeted WS alerts
    assert.equal(targetedWsAlerts.length, 2, "Both users should receive targeted WS alerts");
    const user1Ws = targetedWsAlerts.find(a => a.userId === "user-1");
    const user2Ws = targetedWsAlerts.find(a => a.userId === "user-2");

    assert.equal(user1Ws.data.bars, 1, "User 1 WS alert must have bars = 1");
    assert.equal(user1Ws.data.targetUserId, "user-1");
    assert.equal(user2Ws.data.bars, 15, "User 2 WS alert must have bars = 15");
    assert.equal(user2Ws.data.targetUserId, "user-2");
  } finally {
    alertEngine.stop();
  }
});

test("functional: pump alerts never escape the subscriber's selected exchanges", async () => {
  delete require.cache[require.resolve("../alertEngine")];
  const alertEngine = require("../alertEngine");

  const sentTelegram = [];
  const targetedWsAlerts = [];
  const mockUserStore = {
    getAllUsers: () => ({
      "exchange-filter-user": {
        id: "exchange-filter-user",
        telegramChatId: "tg-exchange-filter",
        preferences: {
          notifications: {
            tgEnabled: true,
            pumpDump: {
              enabled: true,
              periodMinutes: 1,
              minPct: 1,
              minVolume: 1000,
              direction: "both",
              marketType: "both",
              exchanges: ["BN", "BB"],
              cooldownSeconds: 1
            }
          }
        }
      }
    })
  };

  const tickers = new Map([
    ["BN:ALLOWEDUSDT", { key: "BN:ALLOWEDUSDT", p: 103, v: 5_000_000 }],
    ["MX:BLOCKEDUSDT", { key: "MX:BLOCKEDUSDT", p: 103, v: 5_000_000 }]
  ]);

  alertEngine.init({
    tickers,
    userStore: mockUserStore,
    telegramBot: {
      sendAlert: async (chatId, text) => {
        sentTelegram.push({ chatId, text });
        return { ok: true };
      }
    },
    fetchCandles: async () => Array.from({ length: 12 }, (_, i) => ({
      t: Date.now() - (12 - i) * 60_000,
      o: 100,
      h: 104,
      l: 99,
      c: 103,
      v: 1000
    })),
    sendUserAlert: (userId, type, data) => targetedWsAlerts.push({ userId, type, data }),
    broadcastAlert: () => {}
  });

  try {
    const now = Date.now();
    for (const key of ["BN:ALLOWEDUSDT", "MX:BLOCKEDUSDT"]) {
      alertEngine.priceHistory.push(key, now - 60_000, 100);
      alertEngine.priceHistory.push(key, now - 30_000, 101.5);
      alertEngine.processTicker({ key, p: 103, v: 5_000_000 }, now);
    }

    const deadline = Date.now() + 4000;
    while (targetedWsAlerts.length < 1 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise(resolve => setTimeout(resolve, 250));

    assert.equal(targetedWsAlerts.length, 1, "only the selected Binance route may alert");
    assert.equal(targetedWsAlerts[0].data.ex, "BN");
    assert.equal(targetedWsAlerts.some(alert => alert.data.ex === "MX"), false);
  } finally {
    alertEngine.stop();
  }
});
