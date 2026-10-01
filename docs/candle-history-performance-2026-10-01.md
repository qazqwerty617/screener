# Candle history and browser resource audit — 2026-10-01

## Confirmed causes and changes

The initial 300-candle response was painted quickly, but older pages were fetched
only at the left edge. The historical backend route did not share simultaneous
requests or retain closed pages. Every reader repeated an exchange round trip.

- After the first paint, only the active single chart warms older history. The
  warmup stops at 1,200 candles or three pages, whichever comes first, then buffers
  one more page. Panning starts the next page before reaching the left edge.
- Both client and server reuse closed pages and share identical in-flight requests.
  Keys include venue, instrument, timeframe and cursor. The server bounds retention
  to 128 pages / 64,000 candles and 16 distinct pending requests. Closed pages expire
  after five minutes; valid empty pages after 30 seconds. Timeouts and rejected
  responses do not populate the cache.
- OKX and Bitget historical requests now use their history endpoints rather than
  the limited recent-candle endpoints. Documented page limits remain enforced:
  [OKX history API](https://tr.okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks-history)
  and [Bitget history API](https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market).
- API errors, malformed payloads and pages that fail to advance are retryable
  failures. They cannot silently mark the beginning of an instrument's history.
- Live candle appends previously cut a deeply loaded chart back to 3,000 candles,
  or 1,500 in a grid cell. The existing history bounds now apply consistently:
  20,000 on the main chart and 10,000 per grid cell. Cached return and tail refresh
  preserve that history. Grid cells still load deep pages only on demand.
- Stale chart tasks do not start further warmup after a market/timeframe switch,
  hidden document, grid switch or failed page. Existing retry/backoff remains.

EMA, Bollinger Bands, RSI, ATR, MACD, VWAP, CVD and volume SMA now retain their
closed-candle calculations and update the live tail. Changes to history, including
late closed-candle corrections, invalidate the cache. Grid live handlers preserve
tail-update caches; structural changes still invalidate them. ATR includes high/low
in its validity check, and CVD includes high/low/volume, fixing stale output when
the close price remains unchanged. VWAP retains UTC session resets and existing
quote-turnover conversion.

Unchanged formation candles retain their detection until a relevant data or
settings change; elapsed time alone no longer reruns the detector. Closed-candle
corrections invalidate that cache and refresh grid levels without waiting for
another market event. Hidden browser tabs skip local level detection.

Forced grid redraws from input, resize and history handlers now invalidate the
cell for the common render loop rather than painting immediately. Hidden tabs
stop formation snapshot polling. Disabled PUMP/DUMP alerts no longer allocate
price histories for every streamed market or iterate the market map every second.
Enabled histories include only selected venues/market types and retain the selected
observation period plus a small baseline margin, bounded by the existing 900 samples.
Disabling the scanner releases retained rings.

## Validation

- Complete Node suite: **912 passed, 0 failed**.
- Regression tests first reproduced duplicate history requests, unsupported deep
  endpoints, silent end-of-history on API rejection, live history truncation,
  repeated indicator work, stale ATR/CVD, forced grid paints and disabled pump
  history allocations. The fixed paths pass those regressions.
- Indicator tests compare 50 successive live updates over 4,000 candles with a
  fresh full calculation. They also cover prepend, append, retention rollover and
  closed-candle corrections. Proxy counters ensure live updates do not traverse
  the entire closed history.
- Public futures API smoke check: BTC one-minute history 40 days old, six venues.
  Actual route and parser are exercised without starting production services:

| Venue | Candles returned | Cold upstream request |
| --- | ---: | ---: |
| Binance | 1,000 | 403 ms |
| Bybit | 1,000 | 670 ms |
| OKX | 100 | 475 ms |
| Bitget | 200 | 395 ms |
| KuCoin | 400 | 536 ms |
| HTX | 1,001 | 652 ms |

Warm route lookup measured 0.03–0.05 ms in this process. That excludes JSON
serialization, HTTP transfer and browser rendering; it is not end-to-end latency.
Run `node tools/checkHistoryEndpoints.cjs` from `node-server` to repeat the check.
These are individual successful requests, not a sustained provider benchmark.

`node tools/benchmarkChartTail.cjs 7f82bdc` compares the production calculation
functions with the preceding commit, using eight indicators and 200 live updates:

| Loaded candles | Previous calculation time | Updated calculation time |
| --- | ---: | ---: |
| 4,000 | 2,252.21 ms | 2.92 ms |
| 20,000 | 11,448.39 ms | 4.28 ms |

This deterministic Node microbenchmark excludes paint, sockets, tables and all
other application work. It establishes removal of repeated history traversal;
it must not be presented as a whole-application speedup or a laptop CPU result.

The browser check uses production frontend assets with a local fixture backend
and a simulated 150 ms upstream page delay. The initial 300 candles automatically
grow to 1,300; applying the buffered page yields 2,300. A timeframe switch and
return preserve the previously loaded 2,300 candles. No browser runtime errors
were observed in that scenario. The new frontend version is `app.js?v=2108` in
both preload and script tags.

## Limits

Cold history still depends on provider latency, retention and rate limits. Prefetch
cannot make arbitrary uncached depths instant or obtain history a venue does not
offer. The live API smoke check covers six futures venues on one symbol/timeframe;
it does not certify every instrument, spot market or exchange. Automated tests
exercise additional synthetic timeframes and failure scenarios.

The cache and chart retention bounds deliberately remain finite. Every grid cell
does not preload all history. No multi-day production soak, low-end laptop CPU/RAM
measurement or production deployment was performed. Git delivery and deployment
are separate operations.
