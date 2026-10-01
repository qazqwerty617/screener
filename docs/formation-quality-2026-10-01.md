# Formation accuracy, confirmed cards and notification layout

## Behavior

The Formations workspace now requires both a server candidate and valid chart
geometry before creating a card. A stale Range snapshot whose loaded candles
have broken its boundaries no longer leaves a plain chart or an unconfirmed
markup message. The same live-price, minimum-touch and distance rules apply to
card selection and drawing for levels, trendlines, retests, ranges and cascades.
Cascade minimums count clean nearby levels on one side, not opposite-side steps.

After a live break, the card hides immediately and disposal/re-pagination is
coalesced outside the draw call. A valid pattern remains selected when the user
pans its markup outside the visible area. Notification navigation can prioritize
a qualifying market but cannot insert a coin outside the selected formation.

Cold candidates download candles before appearing. Empty/failed candle downloads
use a 30-second retry backoff. Warmup uses three workers, at most 24 requests per
batch, and a 15-second budget of max(24, four pages). A cursor resumes at later
candidates so early failures cannot starve the rest. Hidden documents do not
start new warmup work. The existing background refresh drives subsequent cycles;
no additional polling timer or exchange stream was added. Reload persistence
includes the candles after validation, rather than persisting an empty warmup.
Malformed snapshot rows preserve the last valid workspace and show offline state.

## Detector fixes

- All six shared detectors validate every OHLC row and interval, including
  object, string-valued and array inputs. Null rows, nonfinite values, impossible
  candle bodies, duplicate/reversed timestamps and gaps produce no confirmed
  result. Invalid bars are not silently dropped to manufacture a pattern.
- Trendline primary anchors require independent visits with a meaningful
  departure between them. An inserted pivot must depart from both adjacent
  established touches, preventing a second anchor visit from being counted twice.
  Price hovering along a line no longer counts as a two-touch formation.
- Wick-break tolerances, slope comparisons and pinbar ratios use price-relative
  numeric precision. Cheap tokens no longer inherit a fixed absolute epsilon
  that hides a break or suppresses a legitimate retest reaction.
- Unified scans share suffix extrema for level cleanliness and price spans.
  Horizontal touch collection no longer repeats array membership searches and
  sorting. Impossible current trendlines are rejected before historical scans;
  Range does not repeat the context's OHLC/continuity validation and sorting.
- Active formation calculations use at most the latest 600 candles, preserving
  the existing 400-bar pivot search with extra context for earlier projection.
  Full input validation remains linear. Returned indices, anchors and apexes are
  rebased to the caller's original history; no chart/history candles are deleted.
- Snapshot projection uses binary timestamp lookup instead of allocating a map
  for every candle. The existing WeakMap cache still prevents recalculation on
  pointer movement and invalidates on candle/source changes.

Existing detector fixtures with closes below lows or above highs were repaired
to represent valid market candles. Separate invalid-input regressions verify
that production validation rejects those conditions.

## Notification window

The dialog retains its existing dark style and controls. Two columns have zero
minimum intrinsic width, long labels and button groups wrap, and narrow screens
use one column. Custom percentage inputs and exchange/blacklist groups fit their
cards. Only the content scrolls; header and footer stay accessible. Footer actions
also wrap on small screens. Language, saved settings and notification behavior
remain unchanged. Asset versions are bumped to refresh cached browser files.

## Verification

- Full Node suite: **1047 passed, zero failed, zero skipped**.
- Regression scenarios include blank cards after a live Range break, broken
  levels, recovery, cold/failed downloads, malformed snapshots, timeframe/market
  isolation, shared distance/touch filters, priority navigation, large rejected
  candidate sets with bounded request counts, tiny-price breaks and pinbar-only
  retests, primary anchor separation, and original long-history indices.
- Real frontend in the in-app browser against local mocked APIs: live break
  removed the card; recovery restored its markup. Settings saved and reopened
  correctly, including custom percentage controls. RU and EN layouts were checked
  at 1280x720, 900x650 and 390x844 with no horizontal content overflow and visible
  footer actions. No external Telegram messages were sent.
- JavaScript syntax checks and `git diff --check` passed.

The committed benchmark `node-server/benchmarks/formationDetectors.cjs` uses seed
617, 20 warmup scans and 51 measured scans. Baseline is commit `929e661`; both
versions use the same input and shared scan entry point. Local results:

| Input | Baseline median / p95 | Updated median / p95 |
| --- | --- | --- |
| 400 noisy bars | 0.518 / 0.845 ms | 0.416 / 0.593 ms |
| 20,000 periodic bars | 29.219 / 31.553 ms | 0.446 / 0.777 ms |

Result counts matched in these benchmark fixtures. These CPU measurements are
scenario-specific, not a measured site-wide FPS or a promise of trading accuracy.

## Practical limits

Missing source candles cannot certify a pattern. During a cold load or provider
failure, affected candidates remain absent until their candles can be validated.
The scan is for active recent formations, not an exhaustive historical pattern
archive. Older retest snapshots without hold metadata still have less historical
validation until the updated backend refreshes them. Browser checks used mocked
data; they do not establish live-exchange coverage, multi-day uptime or a fixed
FPS on every laptop/display. No production deployment was performed.
