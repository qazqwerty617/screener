"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// Server hot-path and resource invariants.
//
// Static verification of the server-side optimisations. These cover the request
// handlers that every connected client polls, the timers that run 24/7, and the
// blocking operations that used to stall the 20 Hz market broadcast.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const USERSTORE = fs.readFileSync(path.join(ROOT, "userStore.js"), "utf8");
const SHIELD = fs.readFileSync(path.join(ROOT, "securityShield.js"), "utf8");
const CORR = fs.readFileSync(path.join(ROOT, "correlationEngine.js"), "utf8");
const DEPTH = fs.readFileSync(path.join(ROOT, "depthAnalyzer.js"), "utf8");

/** Strip comments so a comment describing an anti-pattern is not a match. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1");
}
const CODE = stripComments(SRC);

// ── correctness bugs that were silently swallowed ────────────────────────────

test("the Binance mirror fallback is reachable from the error path", () => {
  // `fetchImpl` was declared with `const` *inside* the try block, so the catch
  // path threw ReferenceError straight into a bare `catch (_) {}` — the mirror
  // fallback on a network error had never once worked.
  assert.match(SRC, /async function getFetchImpl\(\)/);
  assert.ok(!/const fetchImpl = useNativeFetch/.test(SRC), "fetchImpl must not be block-scoped in the try");
  const start = SRC.indexOf("async function apiFetch(");
  const body = SRC.slice(start, SRC.indexOf("\n}", SRC.indexOf("for (let i = 0; i <= retries; i++)", start)));
  assert.match(body, /const fetchImpl = await getFetchImpl\(\);/);
  // Each attempt needs its own AbortController: reusing an aborted signal made
  // the fallback reject instantly.
  assert.match(body, /const attempt = async \(targetUrl\) => \{/);
  assert.match(body, /const ctrl = new AbortController\(\);/);
  const attemptCalls = (body.match(/await attempt\(/g) || []).length;
  assert.ok(attemptCalls >= 3, `every request path must go through attempt() (found ${attemptCalls})`);
});

test("retry backoff is jittered", () => {
  // Without jitter, concurrent failures retry in lockstep and re-trigger the
  // same rate limit that caused them.
  assert.match(SRC, /Math\.random\(\) \* backoff/);
});

test("GET /api/tickers is registered exactly once", () => {
  const n = (SRC.match(/app\.get\("\/api\/tickers"/g) || []).length;
  assert.equal(n, 1, `${n} handlers — Express matches the first and the rest are dead code`);
});

test("the error handler is the last layer and maps client faults to 4xx", () => {
  const errIdx = SRC.indexOf('console.error("[UNHANDLED]"');
  const catchAll = SRC.indexOf('app.get("*"');
  assert.ok(errIdx > catchAll,
    "the error handler must be registered after the SPA catch-all or errors thrown there leak a stack trace");
  // Express sets status 400 on a malformed percent-escape in the path.
  assert.match(SRC, /const status = Number\(err && \(err\.status \|\| err\.statusCode\)\);/);
  assert.match(SRC, /if \(Number\.isInteger\(status\) && status >= 400 && status < 500\)/);
  // Per-route body parsers land here, not at the early copy of the check.
  assert.match(SRC, /err\.type === "entity\.parse\.failed" \|\| err\.type === "entity\.too\.large"/);
});

test("async route handlers cannot reject unhandled", () => {
  // Express 4 does not catch rejected promises: an unguarded rejection sends no
  // response at all and the client hangs until requestTimeout (30s).
  for (const route of ['app.get("/api/kucoin-token"', 'app.get("/api/backtest/new"']) {
    const start = SRC.indexOf(route);
    assert.ok(start > 0, `${route} must exist`);
    const head = SRC.slice(start, start + 400);
    assert.match(head, /\btry\s*\{/, `${route} must wrap its awaits in try/catch`);
  }
});

test("alertEngine is null-guarded everywhere it is read", () => {
  // `alertEngine` is `let alertEngine = null` with a require inside a try that
  // explicitly tolerates failure, so a bare property read is a TypeError waiting
  // for a load failure. Accesses must be preceded by a truthiness check.
  for (const m of CODE.matchAll(/alertEngine\.[A-Za-z_]/g)) {
    const before = CODE.slice(Math.max(0, m.index - 90), m.index);
    const guarded = /alertEngine\s*&&\s*$/.test(before)
      || /typeof alertEngine\.[A-Za-z_]+ === "function"\)?\s*\{?\s*$/.test(before)
      || /alertEngine\s*&&\s*typeof\s*$/.test(before);
    assert.ok(guarded, `unguarded alertEngine access near: ${JSON.stringify(before.slice(-60) + m[0])}`);
  }
  assert.match(SRC, /\(alertEngine && alertEngine\.DEFAULT_USER_ALERT_SETTINGS\)/);
});

// ── security ────────────────────────────────────────────────────────────────

test("POST /api/user/formation-alerts requires an identity", () => {
  // It used to register any anonymous caller's chatId as a live alert subscriber:
  // both an unbounded growth vector and an alert-injection path.
  const start = SRC.indexOf('app.post("/api/user/formation-alerts"');
  const body = SRC.slice(start, SRC.indexOf("\n});", start));
  assert.match(body, /return res\.status\(401\)/, "an unidentified caller must be refused");
  assert.ok(!/if \(tgId\) \{\s*\r?\n\s*if \(!global\._formationAlertsByChatId\)/.test(body),
    "the unauthenticated write path must be gone");
});

test("the formation subscriber registry is bounded", () => {
  assert.match(SRC, /const FORMATION_CHAT_PREFS_MAX = \d+;/);
  assert.match(SRC, /function setFormationChatPrefs\(chatId, settings\)/);
  // every write must go through the bounded setter
  const raw = (SRC.match(/formationAlertsByChatId\.set\(/g) || []).length;
  assert.equal(raw, 1, "only setFormationChatPrefs may write to the registry");
});

test("CORS answers preflight when it is enabled at all", () => {
  // 15 handlers emitted Access-Control-Allow-Origin but no OPTIONS route existed,
  // so any request carrying an Authorization header failed its preflight.
  assert.match(SRC, /app\.options\("\/api\/\*"/);
  assert.match(SRC, /Access-Control-Allow-Headers", "Authorization, Content-Type"/);
  // `res.vary` appends; setHeader("Vary") would clobber Accept-Encoding.
  assert.match(SRC, /res\.vary\("Origin"\)/);
  assert.ok(!/setHeader\("Vary", "Origin"\)/.test(SRC));
});

test("the security shield never spawns a process synchronously per request", () => {
  // banIp runs on the request path when a flood trips the threshold. execSync
  // there blocks the entire event loop — exactly the wrong response to a flood.
  const start = SHIELD.indexOf("function runIptablesCmd(cmd)");
  const body = SHIELD.slice(start, SHIELD.indexOf("\n}", start));
  assert.match(body, /exec\(cmd, \{ encoding: "utf8", timeout: 4000 \}, \(\) => \{\}\);/);
  assert.ok(!/execSync/.test(body), "the request-path helper must be async");

  // The sync variant may only be used from boot-time chain setup, where blocking
  // is harmless and ordering matters (the chain must exist before rules go in).
  const initStart = SHIELD.indexOf("function initKernelFirewallChain()");
  const initEnd = SHIELD.indexOf("\n}", SHIELD.indexOf("  } catch (_) {}", initStart));
  assert.ok(initStart > 0 && initEnd > initStart, "initKernelFirewallChain must be locatable");

  const syncUses = [...SHIELD.matchAll(/runIptablesCmdSync\(/g)]
    .filter((m) => SHIELD.slice(0, m.index).lastIndexOf("function runIptablesCmdSync") !== m.index - "function ".length);
  assert.ok(syncUses.length > 0, "boot-time chain setup still needs the sync variant");
  for (const u of syncUses) {
    const inInit = u.index > initStart && u.index < initEnd;
    const isDefinition = SHIELD.slice(u.index - 9, u.index) === "function ";
    assert.ok(inInit || isDefinition,
      `runIptablesCmdSync called outside initKernelFirewallChain at offset ${u.index}`);
  }
});

test("a malformed URL cannot throw out of the first middleware", () => {
  // `GET /%E0%A4%A` made decodeURIComponent throw URIError before any handler ran.
  assert.match(SHIELD, /let rawUrl;\s*\r?\n\s*try \{\s*\r?\n\s*rawUrl = decodeURIComponent\(rawTarget\);/);
  assert.match(SHIELD, /\} catch \(_\) \{\s*\r?\n\s*rawUrl = rawTarget;/);
});

test("the rate limiter does not rebuild its window array per request", () => {
  // Two O(n) passes plus a fresh array allocation per request, per IP, at up to
  // 800 retained timestamps.
  assert.ok(!/timestamps = timestamps\.filter\(/.test(SHIELD), "no per-request array rebuild");
  assert.match(SHIELD, /while \(firstFresh < timestamps\.length && now - timestamps\[firstFresh\] >= 60000\) firstFresh\+\+;/);
  assert.match(SHIELD, /for \(let i = timestamps\.length - 1; i >= 0 && now - timestamps\[i\] < 3000; i--\) reqsLast3s\+\+;/);
});

// ── memory: every per-key map needs a bound or an eviction path ──────────────

test("per-IP shield maps are pruned and capped", () => {
  // One entry per distinct source IP, retained forever, trivially amplified by a
  // rotating-source-IP flood.
  assert.match(SHIELD, /function pruneIpState\(now\)/);
  assert.match(SHIELD, /requestRateMap\.delete\(ip\)/);
  assert.match(SHIELD, /strikeCountMap\.delete\(ip\)/);
  assert.match(SHIELD, /lastTelegramAlertMap\.delete\(ip\)/);
  assert.match(SHIELD, /const MAX_TRACKED_IPS = \d+;/);
  assert.match(SHIELD, /pruneIpState\(now\);/);
});

test("correlation histories evict symbols that stopped ticking", () => {
  // ~8.5k keys x 120 doubles, never pruned, persisted and reloaded on boot.
  assert.match(CORR, /const STALE_TICKS_BEFORE_EVICT = \d+;/);
  assert.match(CORR, /histories\.delete\(key\);\s*\r?\n\s*this\.correlationMap\.delete\(key\);/);
});

test("correlation samples are typed rings, not push/shift arrays", () => {
  assert.match(CORR, /new Float64Array\(MAX_SAMPLES\)/);
  assert.ok(!/hist\.shift\(\)/.test(CORR), "shift() is O(n) and ran per ticker per tick");
  const start = CORR.indexOf("function pearsonAbsRings(x, y)");
  const body = CORR.slice(start, CORR.indexOf("\n}", start));
  assert.ok(!/\.slice\(/.test(body), "Pearson must not allocate per call");
});

test("correlation broadcasts only changed keys", () => {
  // The full ~8.5k-key map went out every 5 seconds regardless of movement.
  assert.match(CORR, /this\.broadcastFn\("correlations", changed\)/);
  assert.match(CORR, /if \(this\.correlationMap\.get\(key\) !== corrVal\)/);
});

test("the order-book cache is bounded", () => {
  // Keyed ex:sym with a caller-influenced key space, each entry up to 500 levels.
  assert.match(DEPTH, /const CACHE_MAX_ENTRIES = \d+;/);
  assert.match(DEPTH, /function pruneCache\(now\)/);
  assert.match(DEPTH, /pruneCache\(now\);/);
  // and the O(n) ticker fallback scan is gone
  const code = DEPTH.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.ok(!/\[\.\.\.tickers\.values\(\)\]\.find/.test(code),
    "the linear fallback materialised an ~8.5k array to return undefined");
  assert.match(DEPTH, /return tickers\.get\(`\$\{ex\}:\$\{sym\}`\);/);
});

test("server-side caches all have an eviction path", () => {
  assert.match(SRC, /function pruneJournalSyncCache\(\)/);
  assert.match(SRC, /const JOURNAL_CACHE_MAX_ENTRIES = \d+;/);
  assert.match(SRC, /function pruneFormationCaches\(\)/);
  assert.match(SRC, /pruneFormationCaches\(\);/);
  assert.match(SRC, /const PUMP_ALERT_CACHE_MAX = \d+;/);
  // the coin and paced cooldown maps need a ceiling, not just a TTL
  assert.match(SRC, /if \(serverFormationCoinCooldown\.size > FORMATION_COOLDOWN_MAX\)/);
  assert.match(SRC, /if \(serverFormationLastSentAt\.size > FORMATION_COOLDOWN_MAX\)/);
});

test("ticker_map broadcasts only the new keys", () => {
  // Each insert used to serialise the entire index to every client.
  assert.ok(!/Object\.fromEntries\(tickerIndex\)/.test(SRC.slice(SRC.indexOf("function getTickerIndex"), SRC.indexOf("function getTickerIndex") + 900)),
    "the whole index must not be re-sent per insert");
  assert.match(SRC, /JSON\.stringify\(\{ type: "ticker_map", data: Object\.fromEntries\(newKeysBuffer\) \}\)/);
});

test("no Promise.race leaves its timeout armed", () => {
  // The scanner races per coin per timeframe; the losing timers accumulated.
  assert.match(SRC, /function raceWithTimeout\(promise, timeoutMs, timeoutValue = null\)/);
  const leaked = SRC.match(/Promise\.race\(\[[^\]]*setTimeout/g);
  assert.equal(leaked, null, `every race must go through raceWithTimeout: ${leaked}`);
});

// ── blocking the event loop ─────────────────────────────────────────────────

test("password hashing runs on the threadpool", () => {
  // scrypt N=32768 is ~32 MB and ~100 ms of blocking CPU. Under a credential
  // flood the sync form stalls the 20 Hz broadcast and every other request.
  assert.match(USERSTORE, /function hashPasswordAsync\(password, salt\)/);
  assert.match(USERSTORE, /crypto\.scrypt\(passwordText, saltBuffer, 64, SCRYPT_PARAMS,/);
  assert.match(USERSTORE, /async function verifyPasswordAsync\(password, user\)/);
  assert.match(USERSTORE, /async function registerUser\(/);
  assert.match(USERSTORE, /async function loginUser\(/);
  // the async path must be the one the routes use
  const login = USERSTORE.slice(USERSTORE.indexOf("async function loginUser("), USERSTORE.indexOf("// Telegram Authorization"));
  assert.match(login, /await verifyPasswordAsync\(passwordText, foundUser\)/);
  assert.match(SRC, /await userStore\.loginUser\(/);
  assert.match(SRC, /await userStore\.registerUser\(/);
});

test("registration re-checks uniqueness after the await", () => {
  // A concurrent registration could claim the same email while scrypt ran.
  const body = USERSTORE.slice(USERSTORE.indexOf("async function registerUser("), USERSTORE.indexOf("// Login user"));
  const checks = (body.match(/Пользователь с таким Email уже зарегистрирован/g) || []).length;
  assert.equal(checks, 2, "uniqueness must be checked before and after the await");
});

test("request-path persistence is debounced and non-blocking", () => {
  // saveJSON does openSync + writeFileSync + fsyncSync + renameSync. Calling it
  // from getUserByToken (every authenticated request) blocked the whole process
  // on an fsync of a file that reached ~12 MB.
  assert.match(USERSTORE, /function saveJSONDebounced\(filePath, data\)/);
  assert.match(USERSTORE, /fs\.writeFile\(tempPath, json, \{ mode: 0o600 \}/);
  assert.match(USERSTORE, /process\.once\("exit", flushPendingWritesSync\)/);

  const tokenFn = USERSTORE.slice(USERSTORE.indexOf("function getUserByToken(token"), USERSTORE.indexOf("// Update profile name"));
  assert.ok(!/[^d]saveJSON\(/.test(tokenFn), "getUserByToken must not call the blocking writer");
  assert.equal((tokenFn.match(/saveJSONDebounced\(/g) || []).length, 3);
});

test("auth logging is O(1) per event", () => {
  // `unshift` on a 5000-element array plus an immediate fsync, on every visit.
  assert.ok(!/authLogs\.unshift\(/.test(USERSTORE), "unshift is O(n)");
  assert.match(USERSTORE, /authLogs\.push\(logEntry\);/);
  assert.match(USERSTORE, /saveJSONDebounced\(LOGS_FILE, authLogs\);/);
  // storage is oldest-first now, so readers must reverse
  assert.match(USERSTORE, /function getAuditLogs\(limit = AUTH_LOG_LIMIT\)/);
  assert.match(USERSTORE, /if \(firstTs > lastTs\) authLogs\.reverse\(\);/);
});

test("the body parser is built once, not per request", () => {
  assert.match(SRC, /const jsonBodyParser = express\.json\(\{/);
  assert.match(SRC, /jsonBodyParser\(req, res, next\);/);
  // and the raw-body copy is only kept where HMAC verification needs it
  assert.match(SRC, /if \(req\.path\.startsWith\("\/api\/pay\/webhook\/"\)\) \{\s*\r?\n\s*req\.rawBody = Buffer\.from\(buffer\);/);
});

test("the throttled cooldown autosave does not block, the shutdown flush does", () => {
  assert.match(SRC, /if \(force\) \{[\s\S]{0,240}?fs\.writeFileSync\(tmp, json, "utf8"\);/);
  assert.match(SRC, /fs\.writeFile\(tmp, json, "utf8", \(err\) => \{/);
});

test("the correlation cache is written asynchronously", () => {
  const save = CORR.slice(CORR.indexOf("  saveCache() {"), CORR.indexOf("  /** Only used from the `exit` hook"));
  assert.match(save, /fs\.writeFile\(CACHE_TMP, json,/);
  assert.ok(!/writeFileSync/.test(save), "the periodic save must not block");
  assert.match(CORR, /saveCacheSync\(\) \{/, "the exit hook still needs a sync flush");
});

// ── per-request cost of the endpoints every client polls ────────────────────

test("the ticker snapshot is serialised at most once per second", () => {
  // ~8.5k tickers => a ~93,500-element array, JSON.stringify and gzip, per
  // request, for a payload its own Cache-Control declares stale after 1s.
  assert.match(SRC, /function makeJsonSnapshotCache\(build, ttlMs = SNAPSHOT_CACHE_TTL_MS\)/);
  assert.match(SRC, /const getTickersSnapshotJson = makeJsonSnapshotCache\(/);
  assert.match(SRC, /const getCorrelationsJson = makeJsonSnapshotCache\(/);
  assert.match(SRC, /sendCachedJson\(req, res, getTickersSnapshotJson\(\), "private, max-age=1"\)/);
  // compression must not re-encode the cached gzip buffer
  assert.match(SRC, /if \(res\.getHeader\("X-No-Compression"\)\) return false;/);
  assert.match(SRC, /res\.setHeader\("X-No-Compression", "1"\);/);
});

test("pump-alert scans are shared between concurrent callers", () => {
  assert.match(SRC, /const PUMP_ALERT_CACHE_TTL_MS = \d+;/);
  assert.match(SRC, /const hit = pumpAlertCache\.get\(cacheKey\);/);
  assert.match(SRC, /return res\.json\(hit\.payload\);/);
  // and the per-ticker filters must be ordered cheapest-first
  const start = SRC.indexOf('app.get("/api/market/pump-alerts"');
  const body = SRC.slice(start, SRC.indexOf("\n});", start));
  assert.ok(body.indexOf("allowedExSet && !allowedExSet.has(ex)") < body.indexOf("findNearest"),
    "reject by exchange before touching the history store");
  assert.match(body, /const allowedExSet = isAllEx \? null : new Set\(allowedEx\);/);
});

test("price history lookups are logarithmic", () => {
  const store = fs.readFileSync(path.join(ROOT, "priceHistoryStore.js"), "utf8");
  assert.match(store, /_floorIndex\(e, targetSec\)/);
  assert.match(store, /const mid = \(lo \+ hi\) >> 1;/);
  const nearest = store.slice(store.indexOf("findNearest(key, targetMs)"), store.indexOf("toSeries(key)"));
  assert.ok(!/for \(let i = 0; i < e\.len; i\+\+\)/.test(nearest), "findNearest must not scan the ring");
});

test("the ticker sampler runs no faster than the store's resolution", () => {
  // The store keeps one sample per 30s, so a 1 Hz sweep threw away 29 of every
  // 30 passes while still doing a Map lookup per ticker.
  const m = /tickerPriceRing\.pruneStale\(now, RING_KEY_TTL_MS\);\s*\r?\n\s*\}\s*\r?\n\}, (\d+)\)/.exec(SRC);
  assert.ok(m, "the sampler interval must be locatable");
  assert.ok(Number(m[1]) >= 5000, `sampling every ${m[1]}ms is wasted work`);
});

test("kline REST polling is guarded against overlap", () => {
  // One 1s interval per subscription with a 3s fetch budget meant up to three
  // overlapping fetches piling up per subscription.
  const start = SRC.indexOf("function startKlinePolling(sub)");
  const body = SRC.slice(start, SRC.indexOf("\n}", start));
  assert.match(body, /if \(sub\.pollInFlight \|\| sub\.closing\) return;/);
  assert.match(body, /sub\.pollInFlight = true;/);
  assert.match(body, /sub\.pollTimer\.unref\?\.\(\)/);
  const period = /\}, (\d+)\);/.exec(body);
  assert.ok(Number(period[1]) >= 2000, `a ${period[1]}ms poll is faster than the fetch budget`);
});

test("the background prefetcher cannot overlap itself", () => {
  assert.match(SRC, /let prefetchRunning = false;/);
  assert.match(SRC, /if \(prefetchRunning \|\| tickers\.size === 0\) return;/);
});

test("there is one client heartbeat, not two", () => {
  // A 1s `heartbeat` and a 3s `ping` were both broadcast to every client; the
  // client ignores `ping` entirely.
  assert.ok(!/type: "ping", ts: Date\.now\(\)/.test(SRC), "the duplicate ping broadcast must be gone");
  assert.equal((SRC.match(/type: "heartbeat"/g) || []).length, 1);
});

test("every broadcaster tolerates a socket closing mid-send", () => {
  // broadcastStatus ran from a timer with no try/catch, so a send on a socket
  // that reached CLOSING between the check and the write became an
  // uncaughtException.
  const start = SRC.indexOf("function broadcastStatus()");
  const body = SRC.slice(start, SRC.indexOf("\n}", start));
  assert.match(body, /try \{ ws\.send\(msg\); \} catch \(_\) \{\}/);
  assert.match(body, /if \(clients\.size === 0\) return;/);
});

// ── outbound calls need deadlines ───────────────────────────────────────────

test("every outbound fetch has a timeout", () => {
  for (const [, call] of SRC.matchAll(/await fetch\(([\s\S]{0,400}?)\);/g)) {
    assert.ok(/signal:/.test(call), `fetch without a signal:\n${call.trim().slice(0, 200)}`);
  }
});

test("the Telegram https request has a timeout and answers once", () => {
  const start = SRC.indexOf("function sendTextMessage(token, chatId, text, res");
  const body = SRC.slice(start, SRC.indexOf("\n}", SRC.indexOf("reqTg.end();", start)));
  assert.match(body, /timeout: \d+/);
  assert.match(body, /reqTg\.on\("timeout"/);
  // a retry plus an error event could otherwise both write to the response
  assert.match(body, /let settled = false;/);
  assert.match(body, /const finish = \(fn\) => \{/);
});

test("sendTextMessage is defined once", () => {
  const n = (SRC.match(/function sendTextMessage\(/g) || []).length;
  assert.equal(n, 1, "a second copy inside server.listen shadowed the real one");
});

// ── static assets ───────────────────────────────────────────────────────────

test("versioned assets are served immutable, unversioned ones revalidate", () => {
  // index.html cache-busts every asset with ?v=, so those URLs identify immutable
  // content. Serving them must-revalidate cost 7 conditional round-trips per load.
  assert.match(SRC, /const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";/);
  assert.match(SRC, /if \(req\.query\.v !== undefined \|\| LONG_CACHE_DIRS\.test\(urlPath\)\)/);
  assert.match(SRC, /const LONG_CACHE_DIRS = \/\^\(fonts\|img\)\\\/\/;/);
});

test("fonts and images are cached in memory, not re-read per request", () => {
  assert.match(SRC, /for \(const dir of \["js", "css", "fonts", "img"\]\)/);
  // already-compressed formats must not be re-compressed
  assert.match(SRC, /const NO_RECOMPRESS_EXT = new Set\(\[".woff2", ".png"/);
  assert.match(SRC, /const gzipped = compressible \? zlib\.gzipSync\(raw, \{ level: 9 \}\) : null;/);
});

test("the root SPA shell is served from the pre-compressed cache", () => {
  const start = SRC.indexOf("// Serve pre-compressed assets");
  const body = SRC.slice(start, SRC.indexOf("app.use(express.static(", start));
  // The root is mapped to index.html before freshStatic(), while unknown paths
  // fall through to a real 404 instead of creating search-engine soft 404s.
  assert.match(body, /if \(urlPath === "\/"\) urlPath = "index\.html";/);
  assert.match(body, /const cached = freshStatic\(urlPath\);/);
  assert.match(SRC, /res\.status\(404\)\.send\(renderNotFoundPage\(\)\)/);
});

test("compression is not applied twice to one body", () => {
  // A per-route compression() instance wins the race to set Content-Encoding and
  // carries library defaults, so the route silently opted out of the tuned global
  // options while doing all the same work.
  assert.equal((CODE.match(/compression\(\)/g) || []).length, 0,
    "a nested compression() instance reverts level/threshold to defaults");
  assert.equal((CODE.match(/app\.use\(compression\(\{/g) || []).length, 1,
    "exactly one global compression middleware");
});
