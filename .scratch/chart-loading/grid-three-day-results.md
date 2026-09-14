# Multi-chart 3d loading and closed-candle tick corrections

Date: 2026-09-08. Production app version: 2080.

## Reproduction

The supplied screenshots showed 12-cell pages at 3d, with MEXC SOPH/STONK/SPACEHOOD/VVV, KuCoin SOPH/ESIM/USELESS, and some new-listing cells stuck on loading.

`node .scratch/chart-loading/remote.cjs grid-3d` initially exited 1: MEXC/KuCoin 3d queries returned zero candles with `X-Klines-Pending: 1`, while the same markets returned daily history. Bybit SOPH, labelled 3d, returned candles spaced **180,000 ms (3 minutes)**. STONK on Gate and Aster returned a legitimate single candle.

Ten source-path regression tests were observed failing before their fixes: four unsupported 3d history cases, streamed one-candle grid loading, one-candle single loading, invalid direct fallback, and three closed-candle tick paths. Additional tests cover retries, live source subscriptions, aggregated OHLCV and pagination.

## Causes and changes

- Bybit's interval `3` means minutes, not days. MEXC `Day3` and KuCoin `4320` are not supported intervals. These 3d requests now aggregate each venue's own daily OHLCV. HTX 3d uses four-hour candles to preserve UTC alignment rather than treating UTC+8 daily candles as UTC days. References: [Bybit Kline](https://bybit-exchange.github.io/docs/v5/market/kline), [MEXC contracts API](https://mexcdevelop.github.io/apidocs/contract_v1_en/), [KuCoin supported Kline intervals](https://www.kucoin.com/docs-new/3470356w0), [HTX Kline](https://huobiapi.github.io/docs/usdt_swap/v1/en/#general-get-kline-data).
- Latest history, historical pagination, polling fallback and live source subscriptions use the same requested interval semantics. Invalid direct-exchange 3d fallback is disabled for those venues; the server performs aggregation. Unchanged native 3d venues retain their exchange-provided candles.
- Aggregation deduplicates source timestamps, preserves first open/last close, takes maximum high/minimum low and sums source volume. Live snapshot replacement does not add the same day's cumulative volume twice. Source buffers are bounded and seeded from history before publishing aggregated live candles.
- Grid batching, caching and chart loaders accept one real candle. A temporary empty attempt schedules a bounded, identity-guarded retry; disposed cells cannot restart it.
- Grid trade handling checks event time and starts a new candle after an interval boundary rather than changing the closed candle. Older trade packets cannot rewind the current close. Single-chart late trade packets are ignored; tick-order state is reset on market/timeframe loading.
- MEXC server tick updates are constrained to their cached candle's time interval. Single-chart ticker fallbacks likewise cannot repaint an old final candle. Grid callbacks are identity-guarded, and a changed ticker cannot mutate the previous market's candles.
- The main official-tick path no longer fabricates intervening zero-volume bars during a gap. Actual missing history is requested. This is not a claim that every pre-existing fallback path has been redesigned.

No CSS, layout, colours or drawing style was changed. Previously deployed privacy fixes remain in place.

## Verification

- Full suite after all source changes and added coverage: `node --test --test-concurrency=2 --test-reporter=dot tests/*.test.js` from `node-server` — **467 tests passed**, exit 0. The preceding full run, before four additional pagination/subscription tests, passed all 463 tests.
- Original `grid-3d` reproduction now exits 0. All tested screenshot markets return nonempty 3d history; multi-candle spacing is 259,200,000 ms. Gate and Aster STONK legitimately return one candle, which the loader now accepts.
- `grid-batch-3d`: 24 unique market/exchange pairs across all 11 venues, including the screenshot markets and an HTX BTC case, returned nonempty streamed batch rows on both passes. All observed adjacent multi-candle spacings were multiples of 3d. First group response times: 243–3569 ms; repeated group response times: 9–272 ms. These are server-local API samples, not browser rendering benchmarks or guaranteed latency.
- `live-3d`: a 25-second subscription probe received candles from BB (22), MX (8), KC (14), HT (7), plus trade events. Every captured candle timestamp matched the expected UTC 3d boundary. First events arrived in 835–3602 ms. Deterministic fixtures additionally verify aggregated OHLCV and daily source-channel selection.
- `synthetic-pages-btc`: Bybit BTC pages 300/300/187, MEXC BTC 300/300/163, KuCoin SOPH 66/66/25, HTX BTC 55/55/55. All three pages per market were HTTP 200 and advanced backwards. Initial SOPH pagination on BB/MX returned an empty older page beyond the returned first market candle; the generic positive-page diagnostic exited 1 for that terminal empty result, so long-history BTC was used for a positive three-page verification.
- Browser loaded `/js/app.js?v=2080`; SOPH 3d rendered, with no captured error-level console messages. The available browser session is FREE: authenticated multi-grid UI was not bypassed. Multi-grid verification used its actual batch API plus the actual loader/class code in regression fixtures.
- Production health returned HTTP 200, with all exchange status entries online. CSS hash is unchanged: `4f32fa44033626b2cd4c5607e599038f46029b2cab8c6457ee486faf1fab9a43`.

## Deployment

Hash-checked upload of only `server.js`, `public/js/app.js`, `public/index.html`, followed by remote syntax checks and restart of only PM2 `server`. No credentials, other services, or unrelated source were deployed.

Backup: `/root/nother/node-server/backups/chart-loading-1788896831412`.

Deployed SHA-256:

- server.js: `a176af21dbcab6dea974847e8bceb627ad719c318f70d116a3889dffddab5277`
- public/js/app.js: `54e2760c3bde6306e1b2084bc19383826d9b9c8d69e009e066377868c0391f7a`
- public/index.html: `671c4b89d7814ec5246674916e431f99134597f7c95d1a9a4b3866e61e2cf591`

No claim is made of exhaustive all-symbol/all-timeframe coverage, identical candle boundaries across all native venues, guaranteed uninterrupted upstream availability, or production multi-user UI coverage.
