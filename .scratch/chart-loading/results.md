# Chart loading and live feed reliability — 2026-09-08

Scope: server-side market-data requests and browser chart-loading logic for BN, BB, OX, BG, GT, MX, KC, BX, HT, HL, AD. User requires preserving the visual design.

## Installed changes

- Deduplicate concurrent browser history requests, including across chart consumers. A regression fixture with 12 consumers now produces one request instead of 12.
- Delay direct exchange fallback by 400 ms; cancel it when the server wins. Fast server/cache responses generate no extra direct exchange calls.
- Remove automatic multi-page history preloads for every grid cell; history remains available when panning. Preserve deep-history loading in the single chart.
- Retry explicit pending responses with bounded attempts and honor the server response deadline; clean up request timers even when fetching or decoding fails.
- Prevent an expired history refresh from overwriting a newer cache entry. Revalidate stale cross-cache responses.
- Stop retries after HTTP 429/418/403 and recognize rate-limit error bodies returned with HTTP 200 for all 11 venues. Honor numeric and HTTP-date Retry-After.
- Add a hard deadline covering upstream headers and body decoding, even when the transport does not settle promptly on abort. This also lets stalled exchange initialization fail and retry normally.
- Remove the incorrect Binance futures-to-spot fallback. Correct Aster's browser REST host.
- Correct KuCoin futures candle topic, timeframe notation, candle.stick payload decoding and 9-second heartbeat (previously 20 seconds).
- Publish only the latest candle from Bitget/Hyperliquid initial snapshots, avoiding hundreds of historical bars being sent as live updates.
- Invalidate disposed grid loads and clear previous-instrument candles when the cell's identity changes.
- Coalesce grid history by exchange/timeframe into a streaming batch. Each completed cell resolves independently; only unfinished cells fall back after a broken stream. Limit cold server batch concurrency to six.
- Remove global mouse handlers when disposing grid cells and ignore delayed draws on disposed instances. Five rebuilds of twelve cells previously retained sixty handlers of each type; regression tests now retain zero.
- Let MEXC ticker initialization complete without waiting for optional contract-size metadata; enrich metadata when it arrives.
- Bump the app script cache version from 2075 to 2077.

## Verification

- `npm test` in `node-server`: **427 passed, 0 failed**. Includes 12 reliability tests and 8 multichart lifecycle/streaming tests; failing-before/fixed-after runs were performed for the reproduced defects, following the diagnosing-bugs workflow.
- Production BTC 5m history: valid nonempty results on all 11 venues before and after changes.
- Pre-change 25-second live check: no events from OX, BG, AD (unknown symbols while initialization was stalled), or KC (incorrect subscription).
- Post-change 25-second live checks received both candles and market updates from all 11 venues. Checks immediately following restart can reject a symbol while its catalog is still initializing; allow startup to finish before evaluating steady-state availability.
- Browser: public Binance chart opened, switched 4h → 5m → 15m → 4h; app script version 2076 confirmed; no captured browser error-level messages after testing. Other venues' UI is PRO-gated in this browser session, so their verification used the production API and WebSocket directly.
- Final-release browser verification: app version 2077 loaded, Binance 5m candles rendered, no error-level messages in the last 100 captured console entries. The PRO-only grid itself was not exercised in an authenticated browser; its actual class and loader were exercised in regression tests, and its endpoint was tested through the public production reverse proxy.
- CSS SHA-256 unchanged: `4f32fa44033626b2cd4c5607e599038f46029b2cab8c6457ee486faf1fab9a43`. HTML differs from the pre-task server copy only in the app script version. Rendering styles and geometry are unchanged; disposed instances now exit before drawing.

## Final multichart release measurements

Public HTTP through the production reverse proxy, Binance 5m, twelve distinct instruments, 300 candles each, one streaming request:

| Sample | First cell data | All 12 cells' data |
|---|---:|---:|
| First pass after deployment, mixed cache state | 513 ms | 4929 ms |
| Immediate repeat | 437 ms | 533 ms |
| Later cached pass | 398 ms | 483 ms |
| Later cached repeat | 292 ms | 368 ms |

These measure history delivery, not canvas rendering or a guaranteed latency. Partial response arrival was observed through the real proxy, not just in mocks.

Final-release BTC history returned nonempty data for all 11 venues. A subsequent 25-second live check received candles and market events from all 11; KuCoin's first event took 20.55 seconds. All 11 subscriptions were connected in the health snapshot. An earlier check during startup timed out its 10-second health request and saw no KuCoin event within 25 seconds. Server CPU was approximately 125% of one core on a four-core machine, with another pre-existing Node process using 100%; these checks do not establish elimination of load-related stalls. Repeated individual history requests during startup took 0.52–1.37 seconds, slower than the previous release's steady-state sample below. No unrelated process was stopped or reconfigured.

## Timing samples (server-local API, milliseconds)

These are samples, not a controlled load benchmark or an end-to-end browser latency guarantee. Before-update server caches and load differed from the post-restart state.

| Venue | Before first pass | Before repeat | After restart first pass | After repeat |
|---|---:|---:|---:|---:|
| Binance | 170 | 61 | 418 | 73 |
| Bybit | 431 | 56 | 2003 | 73 |
| OKX | 683 | 54 | 1628 | 67 |
| Bitget | 486 | 455 | 1434 | 43 |
| Gate | 329 | 460 | 1415 | 42 |
| MEXC | 385 | 458 | 1622 | 40 |
| KuCoin | 71 | 89 | 376 | 36 |
| BingX | 414 | 92 | 812 | 46 |
| HTX | 505 | 92 | 954 | 46 |
| Hyperliquid | 568 | 18 | 520 | 44 |
| AsterDex | 683 | 18 | 391 | 49 |

First-opening speed improvement is not established by these samples. The demonstrated improvements are request reduction, recovery correctness, reduced repeated-load spikes, and restored live subscriptions. KuCoin's first live event was about 14 seconds in two server checks; a direct exchange probe opened in 1.50s, acknowledged in 1.75s, and delivered its first trade at 10.83s. This distinguishes connection setup from the arrival of an exchange update.

## Deployment and rollback

Only `/root/nother/node-server/server.js`, `public/js/app.js`, `exchanges/mexc.js`, and the two script-version references in `public/index.html` were updated. Only the PM2 `server` process was restarted. Go scanner, orchestrator, credentials, user records and unrelated local changes were preserved.

Original release backup: `/root/nother/node-server/backups/chart-loading-1788813925444`.
Additional incremental backups: `chart-loading-1788814151379`, `chart-loading-1788814616869` in the same backups directory. Local pre-change source is under `.scratch/chart-loading/before/`.

Final multichart release backup: `/root/nother/node-server/backups/chart-loading-1788858951781` (all four files). Matching local backup: `.scratch/chart-loading/before-multichart/`. This backup restores the previously deployed version 2076. Upload hashes and JavaScript syntax were verified before restarting the process, and deployed hashes were re-read afterward.

Restoring the state before this entire task requires restoring the initial release's three backed-up files plus the MEXC module from the multichart backup, then restarting only `server`; use a new script version when rolling back so browsers do not retain an incompatible cached bundle. Do not run the repository's broad deploy script for this fix.

## Protocol references

- [Binance spot market-data endpoint](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md): a spot endpoint is not a futures price source.
- [KuCoin futures candles](https://www.kucoin.com/en-au/docs-new/3470086w0): `limitCandle`, interval names, and `candle.stick` data layout.
- [KuCoin connection and heartbeat](https://www.kucoin.com/docs-new/websocket-api/base-info/introduction): per-session heartbeat requirements and delayed push when the market has no new data (see candle documentation).

No claim is made that every symbol/timeframe has been exhaustively tested or that exchange outages and IP limits can be eliminated. The changes honor exchange limits rather than bypassing them.
