# Incomplete chart history: viewport follow-up

Date: 2026-09-08. Deployed app version: 2079.

## Reproduction and corrections

The supplied screenshot showed history beginning part-way across the chart. The exact exchange, symbol and timeframe were not confirmed by the user. Source-based regression fixtures reproduced these causes before the fixes:

- The single-chart draw path requested older history only with a positive pan offset. Zooming out with a zero/negative offset could expose blank history without requesting it. The trigger now depends on the visible historical boundary.
- A redraw while the loading lock was still held could leave the next required page waiting for another gesture or market update. Completion now releases the current request's lock before scheduling the next draw.
- Failed historical HTTP requests were converted into successful empty history and could permanently mark the market's beginning. The server now returns a retryable 503 for upstream failures. The shared browser loader rejects errors, invalid pages and non-advancing cursors, with bounded deadlines and identity-guarded exponential retries.
- Grid history prepends increased an offset measured from the newest bar, shifting the visible window. Prepending now preserves that offset. Disposed/replaced cells cannot apply stale completion results.
- HTX range queries included `size`, causing `from`/`to` to be ignored. Older queries now use the time range alone, as specified in the [official HTX perpetual-swap Kline documentation](https://huobiapi.github.io/docs/usdt_swap/v1/en/#general-get-kline-data). Latest requests retain `size`.
- KuCoin two-part historical reads no longer silently swallow a failed part and return a partial page as complete.

No CSS, drawing geometry, colours, layout or chart controls were changed. Historical candles are fetched, not invented. Client history remains bounded to 20,000 single-chart bars and 10,000 grid bars.

## Verification

- Seven regression tests in `node-server/tests/historyViewport.test.js` were reproduced failing before their corresponding fixes. The integrated fixture runs the real draw trigger and asynchronous loader through three pages until a 500-bar viewport is filled without additional gestures or live ticks.
- Full suite: `node --test --test-concurrency=2 tests/*.test.js` from `node-server` — **451 passed, zero failed**.
- Production HTTP pagination after deployment: Binance BTCUSDT and CROSSUSDT 1m each returned 300 initial bars followed by two strictly older 1,000-bar pages. HTX BTC-USDT 1m returned 300 initial bars followed by two strictly older 1,001-bar pages. All nine responses were HTTP 200; sampled server-local request times were 204–1268 ms. Adjacent page boundaries in these samples were one minute apart. These timings are samples, not end-to-end latency guarantees.
- Browser DOM confirmed `/js/app.js?v=2079`. Binance BTC 1m rendered, then remained filled on the historical side after repeated zoom-out wheel gestures. Selecting CROSS 1m at the reduced scale displayed approximately nine hours of candles across the chart, with no blank historical region on the left. No captured error-level console messages. The intentional future-space area to the right of the latest candle was not altered.
- Production health endpoints returned HTTP 200, and exchange status entries reported online. The BTC 1m live subscription was connected during the health check.
- Production CSS SHA-256 remained `4f32fa44033626b2cd4c5607e599038f46029b2cab8c6457ee486faf1fab9a43`.

## Deployment and limits

Only `server.js`, `public/js/app.js` and the app-version references in `public/index.html` were uploaded for this release. Pre-deployment hashes and uploaded hashes were checked; remote JavaScript syntax checks succeeded; only PM2 `server` was restarted. Source backup: `/root/nother/node-server/backups/chart-loading-1788879198321`.

Deployed SHA-256:

- server.js: `38b9086cbcd31ed2278ca1cd64da071ed090848e109f04908318d7e3ae7150b0`
- public/js/app.js: `bffaac67fdf1f7698d7f6828cadee970798f2c187cc7f1a50a520a3a8a03428e`
- public/index.html: `9540989120c38007538fc156ba0f6737d960e3afdfebd40586eb3d79b39cf848`

The available browser session is FREE: authenticated multi-chart and other exchange UI paths were not bypassed. Grid logic is covered by regression fixtures; HTX pagination was checked through the production API. This follow-up does not claim exhaustive validation of all symbols/timeframes, unlimited exchange-provided history, or recovery of gaps that the source exchange does not supply. Previous privacy safeguards remain in place and must not be rolled back.
