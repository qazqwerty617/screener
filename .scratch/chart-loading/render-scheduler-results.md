# Event-driven chart rendering and bounded browser history cache

Date: 2026-09-09. Local app asset version: 2082.

## Reproduced defects

- The animation loop called `ChartInstance.update()` for every visible cell on every frame, even with no changed ticker. In a deterministic 600-frame, 12-cell fixture this produced 7,200 idle chart updates.
- The global ticker feed triggered canvas work even when the cell already had its dedicated official kline/trade subscription, duplicating live rendering work.
- Grid candle mutations did not invalidate memoized indicator arrays. High, low or volume could change while ATR/CVD/VWAP-derived output remained stale.
- The browser candle cache had no size or weight bound, so long sessions across many markets/timeframes could retain an unbounded number of candle objects.

## Changes

- Split ticker-table dirtiness from chart dirtiness and consume only changed visible chart keys.
- Removed synchronous canvas draws from official market-message handlers; the global `requestAnimationFrame` loop now coalesces updates into at most one paint per cell per frame.
- Global ticker updates only refresh cell headers while a dedicated chart stream is active.
- Density messages mark charts dirty instead of rewriting ticker DOM and drawing synchronously.
- Invalidate indicator caches after every official grid candle mutation.
- Added an LRU browser candle cache capped at 128 market/timeframe entries and 120,000 retained candles; entries older than 30 minutes are pruned on writes.
- Bumped both HTML references to `/js/app.js?v=2082`. No CSS, canvas geometry, colours, layout or drawing styles changed.

## Verification

- Red/green regression command: `node --test tests/chartRenderScheduling.test.js tests/clientChartCacheBounds.test.js`.
- Full suite: `npm test` from `node-server` — 482 passed, 0 failed.
- Deterministic idle scheduler comparison, 600 frames × 12 cells: 7,200 chart updates before; 0 after.
- Local browser loaded app version 2082. The 12-cell Binance grid rendered all 12 canvases, then survived rapid 1m → 1w switching with all cells on 1w and no captured warning/error console entries.
- The temporary local server was shut down after verification.

This is a source and local-browser verification. It was not deployed to production in this task.
