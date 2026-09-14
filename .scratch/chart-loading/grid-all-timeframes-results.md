# General multi-chart loading lifecycle

Date: 2026-09-08. Deployed version: 2081.

The user clarified that the complaint concerns all timeframes/markets, not just the 3d cases in the earlier screenshots. This follow-up changes the shared grid-loading path; it is not another exchange-specific timeframe patch.

## Reproduction and corrections

`node --test tests/gridLoadingLifecycle.test.js` initially failed three source-path fixtures:

1. Discarding a queued 12-cell page still sent its HTTP history requests, competing with the newly visible page. The shared request now tracks consumers. Switching timeframe/page or disposing a cell releases its request; fully abandoned queued groups are never sent and fully abandoned in-flight streams are aborted. Cancelling one consumer does not cancel a different cell sharing the same market history. The server stops starting additional queued symbols after the response connection is discarded. Already-running shared upstream refreshes may finish for caching/other consumers.
2. A pending cell waited for the end of another symbol's stalled stream before attempting recovery. The server now emits a pending row for that cell, and the client starts its recovery immediately, independently of the remaining stream. Existing deadlines, throttling protections, retry limits and shared request deduplication remain.
3. A grid cell could borrow the hidden main chart's old candles after the selected timeframe changed. Reuse now checks the actually loaded exchange/symbol/timeframe, not just the selected controls. Borrowed candle objects are cloned so the grid and main chart cannot mutate the same objects.

The tests also cover all eight timeframes selected rapidly, preserving a shared consumer, cancelling an active stream without fallback traffic, and server-side cancellation/pending-row behavior. In the controlled 8 × 12 queued-switch fixture, only the final 12-cell grid issues an HTTP request; the obsolete grids do not.

No CSS, layout, drawing geometry or styling was changed. No claim is made that these deterministic failure cases reproduce every instance of the user's intermittent lag: normal load completed in the observed pre-fix Binance browser session too.

## Verification

- Full suite: `node --test --test-concurrency=2 --test-reporter=dot tests/*.test.js` from `node-server` — **475 tests passed**, exit 0. Targeted lifecycle suite: 8 passed.
- Production matrix before and after deployment: 24 selected market/exchange pairs across 11 venues × 8 timeframes = 192 checks. Every case returned nonempty data; sampled first adjacent timestamps had spacing divisible by the requested timeframe. This is a sample of markets, not an exhaustive sweep of every listing or every candle interval.
- Post-deployment `node .scratch/chart-loading/remote.cjs grid-matrix-summary` exited 0:

| Timeframe | Nonempty / checked | Maximum group API time |
|---|---:|---:|
| 1m | 24 / 24 | 1191 ms |
| 5m | 24 / 24 | 2632 ms |
| 15m | 24 / 24 | 1268 ms |
| 1h | 24 / 24 | 950 ms |
| 4h | 24 / 24 | 3474 ms |
| 1d | 24 / 24 | 1146 ms |
| 3d | 24 / 24 | 2446 ms |
| 1w | 24 / 24 | 1420 ms |

These are server-local batch API measurements, not end-to-end UI timings or a controlled before/after latency benchmark.

- Browser DOM confirmed `/js/app.js?v=2081`. The FREE session does permit the Binance 12-cell screener grid; the prior report's implication that the entire multi-grid UI was unavailable was too broad. Other exchange selection is marked PRO, and was not bypassed.
- In the deployed browser UI, rapid 1m → 5m → 15m → 1h → 4h → 1d → 3d → 1w switching ended with all 12 Binance cells visibly displaying weekly candles. Switching to page 2 and then 1m also rendered all 12 cells. No captured error-level console messages in either check.
- Health endpoint returned HTTP 200. CSS SHA-256 remained `4f32fa44033626b2cd4c5607e599038f46029b2cab8c6457ee486faf1fab9a43`.

## Deployment

Only `server.js`, `public/js/app.js` and `public/index.html` were deployed. Previous remote hashes were checked, upload hashes verified, remote JavaScript syntax checked, and only PM2 `server` restarted. Other services and existing privacy fixes were preserved.

Backup: `/root/nother/node-server/backups/chart-loading-1788899995795`.

Deployed SHA-256:

- server.js: `1821b9676b0fec8afd74604276c9731f76a25d646ebe28923b44c878ddb6abaa`
- public/js/app.js: `eb72c115459d63b08d96e9771d7fbc498bdb040b3f6e5c55ff2c558e79e6a110`
- public/index.html: `2675fa1837c93961c9e66a58ab3b8b7e19e3c27958171d833a6c705202a09b8e`

No guarantee is made of uninterrupted upstream availability, exhaustive all-listing validation, or identical exchange candle boundaries. A browser refresh is required to load the new client version.
