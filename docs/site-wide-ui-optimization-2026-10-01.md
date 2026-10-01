# Site-wide UI optimisation

Baseline: `9f274bf`. This follow-up covers the shared interface, arbitrage,
funding, CEX–DEX tables, journal, backtest, news and both event calendars.
It builds on the earlier main-chart, ticker-list, formation-grid and radar
optimisations documented in `browser-resource-optimization-2026-10-01.md`.

## Changes and resource bounds

- Arbitrage tables retain rows by route key. Unchanged responses do not rebuild
  their DOM; changed quotes update only changed cells. Unaffected sparklines,
  favourite buttons and focus remain intact. Comparison uses source markup, so
  English translations do not make every unchanged cell appear dirty.
- Sparkline paints coalesce into one requested display frame. An
  IntersectionObserver limits them to visible rows; removed rows release their
  observations. Browsers without this API retain the existing drawing fallback.
  Each table retains metadata only for its current displayed rows, bounded by
  the existing 400-row cap. There are no additional canvas backing layers.
- Backtest interactions request one paint per display frame instead of painting
  separately for every mouse event. Hidden backtests do not paint. UTC axis
  formatting reuses one formatter. Candle and indicator calculations remain
  on the existing paths.
- Journal trade charts similarly coalesce input paints and ignore callbacks for
  closed/replaced canvases. Their rounded backing dimensions are reused rather
  than reallocated on every movement, including fractional Windows scaling.
  DPR changes still resize them and reset the transform correctly.
- Equity-chart hover reuses the current filtered cumulative PnL points and finds
  the nearest uniformly spaced point without scanning all trades. Data/filter
  updates still recompute points and totals. Hover paints coalesce; canvas
  backings are reused. No additional trade-history cache is introduced.
- News, listings and unlock search render the latest query once per requested
  frame. Switching away cancels pending search work. Dates and token quantities
  use a bounded set of reusable locale formatters; changing language resets
  them. Listings keep local dates, unlocks keep UTC dates and precision labels.
- Sidebar and window resize bursts share one chart-layout request per frame.
  Closed/hidden diagnostics stop rebuilding their invisible DOM and enumerating
  the full ticker dictionary every second.
- Initial Russian startup skips a redundant full-document translation walk.
  Selecting the already applied language does not retranslate or dispatch a
  change event. English, switching back to Russian, dynamic labels and profile
  persistence retain their existing behaviour.

These changes add no market subscriptions, network polling timers or permanent
animation loops. Incoming market processing, alert checks, exchange freshness,
existing candle precision and server-side calculations are unchanged. Requested
interaction frames follow the display; background data does not acquire a
120 Hz update requirement. Retained DOM metadata is a small bounded CPU/heap
trade-off; total process memory and laptop power consumption were not measured.

Asset versions: app 2112 (preload and script match), arbitrage 2018, journal
2019, events 15, i18n 3 and lazy backtest 2017.

## Local browser measurements

The in-app browser used the real frontend with local fixture responses and
visible benchmark controls. Input scenarios last about 2.2 seconds and issue
three mouse events per requested display frame. Frame timing measures rAF
delivery, while paint counts instrument the actual selected canvas. This is a
short rendering comparison, not a production throughput or low-end hardware
certification.

| Scenario | Baseline | After |
| --- | --- | --- |
| Backtest, 300 candles | 1,089 paints / 363 frames; 164.8 FPS | 363 paints / 363 frames; 164.8 FPS |
| Journal equity, 600 trades | 795 paints / 265 frames; 120.3 FPS | 330 paints / 330 frames; 149.8 FPS |
| Unlock search, 800 rows, 18 query changes | 151.3 FPS; maximum frame gap 30.3 ms | 158.4 FPS; maximum gap 18.2 ms |
| Arbitrage, repeated unchanged refreshes | 4,800 added and 4,800 removed DOM nodes | 0 added and 0 removed nodes |

The backtest eliminates two thirds of these paints while preserving display
responsiveness. Journal rendering avoids repeated sorting and backing allocation
as well as reducing paints. The arbitrage count includes normal polling during
ten manual refreshes; HTTP/JSON/render elapsed times are not pure drawing costs.

Additional after-change checks:

- Main chart with 1,300 candles and 5,000 received instruments, 300 mounted
  rows: 283 paints / 283 frames, 128.0 FPS, p95 frame gap 12.2 ms, no long tasks
  during the warm interaction sample.
- Density map with 24 walls: 363 paints / 363 frames, about 165 FPS, p95 frame
  gap 6.2 ms, no long tasks in that interaction sample.
- Settings and profile modals were opened and closed. Profile language
  selection, English-to-Russian restoration, news search and populated
  listings/unlock calendars were checked through their real controls.
- Spread and funding tables displayed 400 rows each, CEX–DEX displayed 100
  exact-contract fixture rows. Existing indicative DEX labels remain intact.
- Main tabs, populated Range view and density-side filters were checked after
  switching between sections. The console contained no errors or warnings.

One initial 5,000-instrument cold-load sample contained a 64 ms long task.
That sample overlapped initial data/DOM loading; it was not isolated to a
specific function and is not claimed fixed. Later warm interaction samples
contained no long tasks. These measurements cannot guarantee 120 FPS on every
machine, especially a 60 Hz display, or prove zero stalls during initial loading.

## Regression verification

**998 Node tests passed, zero failed and zero skipped.** New regression cases
exercise production rendering functions and include:

- identity retention for 400 arbitrary route rows and their canvases;
- changed quotes, row reordering/removal, retained focus and favourite buttons;
- visibility of only eight out of 400 sparklines, with complete removal cleanup;
- one scheduled paint for 100 backtest or journal input requests;
- no late journal paint after canvas removal/replacement;
- unchanged canvas memory dimensions and correct DPR changes;
- current equity totals after data changes, with no repeated hover filtering;
- latest-query calendar rendering after an input burst;
- no hidden diagnostic DOM or symbol enumeration;
- coalesced sidebar chart layout with the latest panel width;
- skipped initial Russian DOM traversal, unchanged-language selection,
  English translation and restoration of Russian text.

The complete suite also covers the existing streams, reconnect, history,
subscriptions, notifications, range formations, indicators and server behaviour.
This does not mean every possible button sequence or multi-day real exchange
load was reproduced in a browser. No production accounts or external messages
were used. Changes were committed to the repository; no live-service deployment
was performed as part of this follow-up.
