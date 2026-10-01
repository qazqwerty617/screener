# Browser resource optimisation and display-rate interactions

Baseline: commit `6579d36`. This follow-up targets redundant rendering and DOM
work without changing exchange subscriptions, market ingestion or alert rules.

## Changes

- Grid chart pointer, zoom, ruler and resize invalidations bypass the old
  16 ms background paint gate. Multiple events still coalesce into the shared
  display frame. Stream-only grid updates retain their existing paint budget.
- Ticker DOM queues contain mounted rows rather than every received market.
  A separate ranking invalidation ensures changes outside the displayed list
  still participate in sorting and filters. Grid ticker queues contain only
  displayed chart markets. All incoming market values remain in the market map;
  alert checks continue in ingestion.
- List ordering moves individual retained nodes instead of detaching all 300
  elements on any rank change. Unchanged row inputs avoid repeated formatting.
  Row flash timers restart only for a new real price. Unchanged header text and
  classes no longer create repeated DOM mutations; funding countdowns still
  update when their displayed second changes.
- Loading grid cells paint once per invalidation and reuse rounded canvas
  dimensions at fractional Windows scaling. Hidden main canvases no longer
  render behind multicharts. The main chart's safety clock redraw skips seconds
  already painted by live data, and also supports expanded formation charts.
- Radar hover and selected-wall lookups are cached by layout generation and
  input. Sorting, filters, changed walls and selections invalidate those caches.
  Only the hovered and selected wall need an extra highlight draw.
- Radar pointer responses follow display frames; idle decorative animation
  retains its existing budget. Empty/hidden radars do not spend extra frames
  on cursor input with nothing to hover.
- Static radar gradients, spokes, rings, labels and walls share the **existing**
  cache canvas. Its 32 MiB pixel bound and empty-map release remain unchanged;
  no additional bitmap layer, WebSocket or polling timer was added. Colour and
  layout changes rebuild the cache. When the wall layer is downscaled on large
  or high-DPI displays, radar labels/rings still render at native resolution.
  The moving sweep, pulse and hover details continue above the cached content.
- The volume tooltip's mean now includes the latest live volume. Closed sums
  are cached, so updates on 20,000 bars remain constant work between structural
  history changes. Closed-candle corrections invalidate the sum. Zero-volume
  history shows a finite multiplier instead of `NaN`.
- Expanded formations paint their main canvas while covered grid cells retain
  pending data without rendering or running hidden formation detection.

The frontend asset version is `app.js?v=2111`, with matching preload and script
URLs. Existing candle values, precision, filters, layout and indicator logic are
retained apart from the corrected tooltip mean.

## Measurements

Local in-app browser fixtures use the real frontend, mock exchange data and
visible benchmark controls. These are rendering measurements, not production
capacity or whole-machine CPU/RAM measurements.

| Scenario | Baseline / before | After |
| --- | --- | --- |
| Grid drag, 2.2 seconds | 121 paints / 363 display frames; 54.9 FPS; p95 0.70 ms | 363 / 363; 164.7 FPS; p95 0.60 ms |
| One row changes rank, 5,000 markets / 300 mounted rows | p95 11.50 ms; mean 7.51 ms | p95 3.40 ms; mean 2.31 ms |
| Market invalidation burst, 5,000 markets | peak row/chart queues 5,000 / 5,000 | 300 / 0 in single-chart mode |
| Burst ingestion timing | mean 0.26 ms; p95 0.50 ms | mean 0.26 ms; p95 0.60 ms |
| Unchanged-list passes, 5,000 markets | p95 2.40 ms; mean 1.68 ms | p95 2.40 ms; mean 1.78 ms |
| Radar hover, 24 walls, before/after backdrop cache | 363 / 363; 164.8 FPS; p95 1.50 ms | 363 / 363; 164.8 FPS; p95 0.50 ms |

The unchanged-list and ingestion timings are effectively unchanged in this
sample. The largest measured gain is avoiding full DOM detach/reinsert during
ranking changes. The main chart with 1,300 candles and 5,000 markets painted
362 / 362 requested frames (164.2 FPS, draw p95 1.10 ms). Higher interactive FPS
does not make background work run at 120 Hz. Performance on a specific low-end
laptop and total power consumption
have not been measured; a 60 Hz display cannot present 120 distinct frames.

## Verification

**987 Node tests passed, zero failed, zero skipped.** New regression cases
exercise production functions and rendering paths, including:

- 120 Hz input versus unchanged stream paint budgets; empty/hidden views;
- a 50,000-market burst with retained-row queues and off-screen ranking changes;
- list moves, inserts, removals, empty filters, selection and colour tags;
- repeated price flashes and stable header DOM with a changing funding clock;
- 5,000-wall hover/selection scans, layout/filter invalidation and static backdrop
  reuse across frames, palette changes, 4K/DPR changes and empty maps;
- 20,000-bar live volume updates, structural history changes, corrected closed
  volumes and zero-volume data;
- existing indicator accuracy, candle clarity, range formations, streams,
  subscriptions, reconnect, notifications and the server test suite.

Browser checks covered the main chart, populated formation chart, expanding it
and returning to the grid, density map, history loading and the large ticker
list. The expanded formation painted 363 / 363 requested frames (164.8 FPS,
draw p95 1.00 ms) with 1,300 candles. The console had no errors/warnings.
No production settings, accounts or Telegram messages were changed. These
changes were not deployed to the live service during this task.
