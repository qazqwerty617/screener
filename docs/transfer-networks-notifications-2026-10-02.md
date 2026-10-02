# Transfer networks and notification delivery audit — 2026-10-02

## Changes

- Spot route details open only on click or Enter/Space. Pointer hover, keyboard focus and favorites never open an overlay or fetch depth.
- Separate selectable cards show the cheapest usable fixed-fee transfer and the shortest available on-chain confirmation estimate. All shared networks remain selectable. Switching cancels older requests, clears dependent figures and rejects late responses.
- Native ETH on explicitly known L2 chains, BNB on BSC and AVAX on C-Chain can qualify without an ERC20 contract. Wrapped assets still require matching contracts. Gate reads the published `addr` field and retains multiple chain records for an asset. Public Bitstamp network statuses/minimums supplement the six existing catalogues; unpublished fees/contracts remain unknown. HTX non-fixed fee formulas cannot qualify as fixed-fee profit.
- Healthy catalogues publish immediately, even while another exchange is loading. Failed refreshes cannot renew the age of stale data.
- Native USDC/FX/bridge routes remain indicative and cannot receive a usable-transfer recommendation through fabricated complete wallet metadata.
- Pump Telegram opt-out is respected for administrators too. An explicitly disabled/blocked account cannot return via the legacy admin fallback. Price alerts remain independent of pump opt-out.
- Pump subscriber caching invalidates immediately on a preferences revision. Queued pump messages check current settings before delivery and retry; disabling during chart rendering or queue wait cancels them. Pump alerts expire after 60 seconds; formation alerts after 120 seconds.
- Browser pump settings use one ordered endpoint that persists both settings representations. Failed writes remain pending, warn in RU/EN, and retry on reconnection or initialization. Late server reads cannot overwrite a newer local choice.
- Range delivery counts both boundaries without requiring a legacy aggregate touch field. Ranking counts balanced visits to both boundaries, preserving cooldowns and pacing. Current Range type, exchange, timeframe, touch threshold, Telegram destination and live price containment are rechecked at send time. Missing legacy aggregate touches no longer create a non-finite confidence value.

## Coverage observed

Replay of public responses captured locally on 2026-10-02:

| Provider | Catalogue assets | Distinct normalized network identifiers |
| --- | ---: | ---: |
| Binance | 971 | 194 |
| Bitget | 4,665 | 245 |
| KuCoin | 2,163 | 337 |
| HTX | 1,167 | 245 |
| Poloniex | 1,073 | 91 |
| Bitstamp | 156 | 43 |

These catalogues contain 6,934 distinct asset labels, including assets not currently tradable. They are **not** a count of active spreads or promised executable routes. Applying old/new identity rules to the same normalized payloads yielded 4,114/4,220 open, identity-verified directional network candidates. Fee, minimum, depth and freshness checks still apply. Gate timed out during the public probe; its changed schema handling is covered by documented fixtures.

Timing models cover BTC, ETH, ARB, OP, BASE, BSC, TRX, LTC, DOGE, ADA, OPBNB and Polygon. Each carries a primary-source link and review date in `transferNetworkTiming.js`. Unsupported networks or absent/invalid provider confirmation counts return no estimate. The catalogue has no twelve-network restriction.

## Verification and limits

Regression loops exercised the shipped scanner, dispatcher, subscriber logic, Telegram queue, settings requests, calculator and frontend scripts. They reproduced disabled-admin pumps, missing Range touch aggregates, Range ranking starvation, queued opt-out, out-of-order settings saves, hover-triggered books, late network responses and slow catalogue publication before fixes.

The actual frontend assets were checked at 1,280 px and 390 px using explicitly labelled synthetic quotes, including RU/EN, selecting OP instead of BASE, closing the modal and unknown Bybit wallet metadata. The modal body had no horizontal overflow at 390 px. This does not prove production exchange profitability or delivery to a real Telegram account.

Full Node suite: `node --test --test-concurrency=2 tests/*.test.js`. The unconstrained parallel run exhausted local process memory in unrelated events/payment tests; both passed separately and the full bounded run passed. No production users were contacted, transactions placed or deployment performed.

Provider limits remain explicit: some venues require authenticated wallet APIs; Bitstamp public fees/contracts are absent; confirmation speed excludes exchange withdrawal review, batching, congestion and deposit processing. Baseline trading fees and unpublished deposit fees remain disclosed assumptions. A guaranteed cheapest/fastest end-to-end transfer for every coin cannot be established from these public APIs.
