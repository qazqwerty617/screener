# Formation overlays, canvas clarity and profile language control

## Confirmed problems and fixes

The Formations list used server snapshots, while its charts independently ran
detectors on their shorter candle histories. A Range detected on 400 candles
could disappear when its card only had the latest 300. Earlier trendline anchors
could also fall outside that history, and cached geometry used indices from a
different candle array.

Cards and expanded formation charts now use the exact snapshot for their
exchange, symbol, timeframe and selected formation type. Touches are mapped by
exact timestamps; older trendline anchors are projected through time without
changing their slope. An authoritative empty snapshot never falls back to a
different local pattern. Prepending history preserves the original geometry.
Automatic price scaling includes the selected formation boundaries; manual
scaling still follows the user's adjustments.

The projection validates loaded OHLC and candle continuity, and checks that a
Range, horizontal level or trendline has not broken since its snapshot. Retest
snapshots include their hold tolerance and validation timestamps so the browser
can invalidate failed holds without rejecting legitimate rejection wicks.
Unavailable or unconfirmed geometry gets an explicit localized chart status.
The retest list now applies the same minimum-touch setting as its overlay.

Formation prices were rounded to six decimal places, turning levels on cheap
tokens into zero. Prices, trendline endpoints and apex prices now retain their
original numeric precision; formatting belongs to the display.

Grid charts used integer DOM dimensions that did not match their actual CSS
boxes at fractional scaling. Main, volume and grid canvas dimensions and origins
are aligned with physical pixels, preventing the browser from resampling their
bitmaps. Small grid headers and price labels are larger. Existing sharp candle
body/wick rendering and user candle styles remain intact.

Profile language selection is a pair of themed RU / EN buttons with visible
selection and keyboard focus. Device-local persistence, cross-window storage
synchronization and the existing change-event integration are retained. There
is no native operating-system dropdown.

## Resource impact

Snapshot projection shares the existing WeakMap cache. Candle changes and a new
snapshot invalidate it; pointer movement reuses it. Cards no longer need to run
local detectors again during their initial candle load. No extra streams,
polling loops, history preloads or continuous decorative animations were added.
Canvas backing stores are resized only when their physical dimensions change.
Requested CSS dimensions are cached too: CSSOM decimal serialization no longer
causes unchanged fractional geometry to be written again on every frame.

## Verification

- Full Node suite: **1022 passed, zero failed, zero skipped**.
- Reproduced the original 400/300-candle Range mismatch before fixing it.
  Regression tests cover snapshot removal, timestamp rebasing, older anchors,
  live breaks, malformed OHLC, gaps, source cache invalidation, tiny prices,
  market/timeframe isolation and retest minimum touches/failed holds.
- Canvas tests cover DPR 1, 1.25, 1.5 and 2, fractional panning, border-only
  candles, physical dimensions and backing-store reuse.
- Browser checks used the real frontend against local mocked APIs: the Range
  card displayed both boundaries and no missing-geometry notice; main/volume
  canvas sizes matched their displayed boxes; RU / EN changed the selected
  language. No browser warnings or errors were observed in these checks.
- JavaScript syntax checks and `git diff --check` passed.

Browser checks used one mocked instrument; they do not establish production
latency, a fixed FPS on every display, low-end laptop performance or multi-day
stability. Missing candle intervals are not silently treated as verified
history. Exact retest hold metadata requires the updated backend detector;
older snapshots remain limited to their existing metadata until refreshed.
No production deployment was performed as part of this change.
