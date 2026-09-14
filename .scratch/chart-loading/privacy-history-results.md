# Single charts, history integrity and private trade isolation — 2026-09-08

## Confirmed causes and changes

The diagnosing-bugs workflow reproduced each defect before patching. Tests use synthetic users/keys and never print production secrets.

- `findLinkedJournalCredentials` / `findLinkedJournalExchanges` copied another account's exchange credentials based on IP, privileged role or matching profile Telegram fields. Removed all implicit linking; lookups are now bound solely to the authenticated user ID.
- A read-only production audit found one duplicate API-key group across four account credential records. Ambiguous legacy records are now persistently quarantined without deleting the encrypted records. Explicit successful reconnection sets ownership version 2. Removing one record cannot reactivate a quarantined copy after restart.
- Trade-overlay state survived logout, and an old in-flight response could render under the next login. State now resets on token/market changes, outstanding requests are aborted, and late responses are rejected. Unauthorized/not-configured responses clear the overlay.
- The browser automatically migrated unowned legacy local API keys to the current account. Removed automatic import. New journal storage is scoped to the owner ID returned by the authenticated server; old unscoped local records remain stored but are not automatically displayed or assigned to a user. Stale async journal responses are ignored after a login change.
- Single charts now render an available cache immediately, refresh the recent tail in the background, and start live subscriptions concurrently with history. Removed automatic full-history preload on every timeframe change; older pages still load on pan.
- History sanitization previously used a global unrelated timeframe to truncate legitimate multi-day history, invented zero-volume placeholder candles, and rewrote genuine isolated high/low values. Sanitization now preserves the exchange-provided series after numeric validation, sorting and deduplication.
- Merging older pages discarded newer non-overlapping history. Both sides are now preserved within the requested candle-count cap.
- Both single and grid live handlers popped all newer candles when a delayed older candle arrived. They now update only the matching timestamp; delayed old updates do not rewind the chart. Grid gaps trigger a bounded recent-history refresh rather than invented candles.

## Remaining server latency investigation

An initial production check after restart still saw 7–10 second history responses, including pending responses; this was not reported as fixed. A later repeated-read sample measured health median 1666 ms / max 4078 ms and cached BTC history median 1149 ms / max 6910 ms (12 requests each).

Two 20-second CPU profiles of the server process showed about 9% idle samples, 8–10% garbage collection, and substantial public ticker message handling (Bitget about 8%, KuCoin about 4.6%, plus other venues). The existing local-only inspector was reused and preserved; profiling was stopped afterward. No private execution data was captured.

A deterministic test against the actual installed WebSocket receiver reproduced starvation: chart work waited behind all 1000 frames in one incoming burst. The public ticker connections now yield between messages with `allowSynchronousEvents: false`. The regression test confirms that pending work runs before the burst ends and all 1000 messages are still delivered. This is a fairness/latency tradeoff, not a claim of lower total CPU or guaranteed throughput; see the [official ws option documentation](https://github.com/websockets/ws/blob/master/doc/ws.md).

Repeated-read measurements after the fairness release (server-local HTTP, 12 requests per endpoint per series):

| Endpoint | Before median / maximum | First after median / maximum | Second after median / maximum |
|---|---:|---:|---:|
| Health | 1666 / 4078 ms | 234 / 1742 ms | 19 / 181 ms |
| BTC 5m history | 1149 / 6910 ms | 171 / 468 ms | 28 / 486 ms |

These samples support improved responsiveness in the observed runs. They are not a controlled throughput benchmark: restart, cache warmth, network and background activity differed. The helper's field labelled `p95` is the maximum order statistic for its small 12-sample series, not a robust latency percentile estimate.

## Verification and deployment

- Before the fairness follow-up: `npm test` — 443 passed.
- Final full suite: `node --test --test-concurrency=2 tests/*.test.js` — **444 passed, zero failed**. The unrestricted parallel rerun encountered local native-canvas/resource failures; bounded parallelism completed successfully without skipping tests.
- Two old tests were updated to the corrected contract: a gap must not silently delete valid historical pages. Source data gaps remain real until fetched; no fabricated OHLCV is presented as exchange history.
- Production privacy check: four total records, four quarantined, zero confirmed; unauthenticated credentials/live endpoints return HTTP 401. No production account sessions were impersonated.
- Final-release BTC 5m history: all 11 venues returned nonempty data, first pass 174–1526 ms and immediate repeat 23–54 ms. A 25-second live check received both candles and market events from every venue; first events arrived in 702–4354 ms. These are sampled API/feed timings, not end-to-end UI guarantees.
- Browser loaded app 2078, trade overlay 2015, journal 2017; Binance 5m candles rendered with no captured error-level console messages. Authenticated multi-account UI testing was not performed; isolation is covered by synthetic regression fixtures plus the production quarantine audit.
- Final browser screenshots confirmed 5m → 15m → 5m with real candles visible immediately on the return screenshot; no captured error-level console entries. No design/layout/style edits were made.
- Source uploads were hash-checked against the previous deployed revision and syntax-checked before restarting only the PM2 `server` process. Go scanner, orchestrator, secrets and unrelated source were left unchanged.
- Primary backup: `/root/nother/node-server/backups/chart-loading-1788860358110` (six source files and a mode-600 encrypted credential-store backup).
- Fairness follow-up backup: `/root/nother/node-server/backups/chart-loading-1788878189419`.

Do not roll back to the vulnerable credential lookup or restore the unquarantined credential file as a routine rollback. The owner must reconnect explicitly; recommend rotating the affected exchange API key and using only read permissions needed for the journal. Old local journal records were retained, not deleted; recovery requires confirmed ownership before assigning them to an account.

No claim is made that every exchange/symbol/timeframe has been exhaustively tested, that upstream gaps are always repairable, or that all load-related latency has been eliminated.
