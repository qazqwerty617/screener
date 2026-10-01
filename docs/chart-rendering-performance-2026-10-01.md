# Chart rendering, loading and profile language

Changes follow the Range formation implementation in commit `2d63031`.
Existing data ingestion, chart interactions and exchange subscriptions remain
in place.

## Reproduced causes and fixes

- The shared animation loop throttled chart input together with ticker-table
  work. A deterministic 60-frame cursor/zoom replay painted only 22 frames.
  Chart invalidations now paint on the next display frame; table processing
  retains its independent 30 Hz budget. Clean charts and hidden tabs do not
  paint continuously. Grid charts retain their existing 16 ms paint budget.
- At fractional Windows display scaling, grid canvases compared integer
  backing dimensions with floating-point CSS dimensions multiplied by DPR.
  At DPR 1.25, a 317 by 243 CSS-pixel canvas reset its backing store 120 times
  during 60 draws. Rounded device dimensions now allocate it just twice
  (one width and one height assignment).
- A one-device-pixel candle placed its wick outside its body, and its border
  extended beyond the body. Fractional pan offsets also changed body width
  from one to two pixels. Bodies now have a stable integer device width;
  wicks and borders stay inside that width. Main and grid charts use matching
  geometry, including fractional body heights. Border-only styles still work.
- Grid candle colours are converted once per draw, rather than six potential
  conversions per visible candle.

These changes affect rendering, not candle values or formation thresholds.
At the minimum zoom, physical screen resolution still limits each candle's
visible width; the renderer does not invent aggregated candles or switch to
a line chart.

## Loading and interface

The screener warms the history cache after a 90 ms pointer pause over an
instrument. There are at most two pending intent requests, restricted to the
visible single-chart screener. Requests share the existing server request
registry with chart clicks and do not open extra exchange WebSockets or direct
REST hedges. Fresh cache entries avoid another request; merging preserves older
history. Failed requests leave existing cache data intact and release the
concurrency slot. Existing history-page prefetching, cursor validation and
20,000-bar limits remain in place.

Language selection now lives in the trader profile and retains device-local
persistence and Russian/English switching. The General settings tab was
removed; settings open directly on Appearance. Short colour transitions and
settings-pane entry animation have reduced-motion handling; switches have a
visible keyboard focus indicator. No continuous decorative animation was added.
Asset versions were updated, with matching chart-script preload and script URLs.

## Verification and limits

- Full Node suite: **959 passed, zero failed, zero skipped**.
- Tests execute the production rendering blocks with a real canvas and check
  sharp pixels at DPR 1, 1.25, 1.5 and 2, main/grid geometry, fractional panning,
  border-only settings and backing-store reuse.
- Production animation-loop tests cover 60, 120 and 144 Hz displays, inactive
  tabs, clean charts, formation-grid invalidations and the independent table
  update budget. Cache tests cover deduplication, retained history, a 1,000-row
  intent storm, inactive views and failed-request recovery.
- A local browser fixture loads the real frontend with one mocked instrument
  and 1,300 candles. During a 2.2-second cursor replay, baseline chart paints
  measured 26.8 FPS (59 paints / 294 display callbacks), versus 129.5 FPS after
  the fix (285 / 285). Draw duration p95 was 1.00 ms versus 0.90 ms. At minimum
  zoom after the fix, 289 / 289 callbacks painted, with p95 0.80 ms.
- Browser checks verified sharp zoomed-out candles, the profile language
  selector, removal of General, opening Appearance, Range chart boundaries
  and saving/reopening its independent notification settings. Telegram was
  disabled in the fixture; no external messages were sent.

The browser measurements isolate rendering on this machine and are not a
production, low-end laptop or many-instrument load benchmark. Cold history
still depends on exchange/network latency; prefetching cannot guarantee an
instant response from an unavailable provider. These commits have not been
deployed to the live service as part of this task.
