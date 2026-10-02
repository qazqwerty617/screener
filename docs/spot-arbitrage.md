# Spot → Spot arbitrage

The arbitrage page now separates futures, funding, USDT spot routes, and CEX–DEX estimates. Spot comparison uses fresh executable best ask/bid, never futures prices, last-trade prices or a USD/USDC conversion. Current providers: Binance, Bybit, OKX, Bitget, Gate, MEXC, KuCoin, HTX, Poloniex, Crypto.com, Kraken, Bitstamp. BingX, Hyperliquid and Aster remain available in their existing futures mode.

## What the user sees

Choose **Spot → Spot**, set the USDT budget, and optionally override BUY/SELL fee percentages, including zero. Empty fee fields select the venue's baseline model, not the account's actual VIP/discounted tariff. The table compares every eligible directed route and shows a ranked page of up to 400 rows. The endpoint permits up to 1,000 rows. Search, exchange selection, volume/minimum result, favorites, sorting and transfer filters apply to this mode. The transfer filter requires a calculable route with verified asset identity, not merely matching network names.

Hover or keyboard focus opens a preview; click/Enter opens a detailed dialog on desktop and mobile. Only the inspected route loads order books. The calculation shows purchase size/average price, trading fee, selected transfer network, withdrawal fee in coins and approximate USDT, quantity arriving, sale average, sale fee, net sale proceeds, remaining quote balance, rounding dust, and profit versus the initial budget. Networks can be switched in the dialog. Confirmations are displayed where provided; no transfer ETA is invented.

The table is a **BBO estimate before market impact**. The detail uses available book depth; both remain conditional simulations, not placed orders or promised future profit. The observed lifetime measures continuous **gross spread > 0**, resets on a nonpositive spread or missing/stale quotes, and starts with this server's first observation. It is not a prediction that prices will survive the transfer. A bounded 50,000-route lifetime registry reports no age for additional untracked routes rather than fabricating one. Futures spread rows also show their observed lifetime.

## Calculation and safeguards

- Default BUY commission is deducted from the purchased base asset. Pure calculator also supports quote-denominated BUY fees; its quote budget includes commission.
- Withdrawal precision/integer multiples round transferred quantity down. Fixed withdrawal and published deposit fees reduce the quantity that can be sold. Unsold dust is never counted as realised USDT proceeds. Withdrawal fees already represent the exchange's charged transfer cost; no duplicate gas fee is added.
- Deposit/withdrawal minimums are checked when published. Unknown fixed withdrawal fees, nonzero variable fee formulas not verified by an adapter, missing/ambiguous identity, or insufficient buy/sell book depth leave final profit unavailable.
- A same ticker or same network is insufficient to verify a token. Native coins qualify on their native chain; other assets need matching valid contract addresses on both exchange catalogues. EVM addresses compare without case; other identifiers compare exactly. Known mismatches are excluded.
- Quote age is at most 15 seconds; cross-venue timestamps cannot differ by over 10 seconds. Detailed books must be at most 5 seconds old and within 5 seconds of each other, checked again after asynchronous fetching. Crossed/empty books, wrong market symbols, API error envelopes and future timestamps fail closed.
- Missing catalogue fees/statuses remain null. Failed refreshes preserve the timestamp of the last successful result; data older than 2 minutes cannot qualify as current transfer availability. Linked-account overlays are private and follow the same expiry.

## Coverage and objective limits

Public wallet metadata comes from Binance, Bitget, Gate, KuCoin, HTX and Poloniex. Existing linked read APIs supplement Binance, Bybit and OKX; MEXC uses configured server credentials when available. Public prices on Crypto.com, Kraken and Bitstamp do not imply public availability of their withdrawal network/fee catalogues: such routes remain candidates until matching wallet data is available. Poloniex child-chain wallets are attached to their traded parent; missing token contracts remain unverified.

Book snapshots do not reserve liquidity. Prices, wallet availability and fees can change during a transfer. Account-specific fees/discounts, order lot sizes, market minimums, withdrawal account limits, destination addresses/tags and transfer timing are not fully verified by this simulator; users must check these on the exchange. Unpublished deposit fees are explicitly modelled as zero, not reported as provider-confirmed. Separate return transfer of USDT is not included: this is one **buy → transfer base → sell** cycle.

No paid API is required. REST feeds poll approximately every 5 seconds per venue, independently of users and other slow venues. Rate limits respect Retry-After/backoff. Quotes and response bodies are bounded; markets with no executable BBO, insufficient reported volume, stale data, stablecoin bases and leveraged wrappers are excluded. The initial live probe on 2026-10-02 received valid quotes from 11/12 providers; Gate timed out from the development host. This is reported as a source outage, not filled with old or synthetic data.

## Resource use and verification

Bulk quote feeds are shared with the density-map spot universe, replacing its repeated bulk requests. Binance/MEXC 24h volumes are cached separately for 60 seconds. Short shared snapshot/page caches and a bounded top-N heap avoid retaining a full execution ledger for every comparison or repeating identical client work. Detailed books share in-flight requests, cache for 2 seconds, limit six simultaneous fetches, bound queue length and retain at most 200 books. Browser rows update by changed cells; hover work is debounced, cancelled on route/parameter changes, and stops when the preview, section or document closes/hides.

Automated coverage includes all 12 adapters, quantity/commission arithmetic, partial books, rounding/minimums, unknown fees, contracts, wallet metadata expiry, per-venue progress, Retry-After, shared book caching, directed lifetime resets, top-N pagination, endpoint validation/private caching, late UI responses, mode transitions, local input validation, stale rows and English copy. Actual BTC books were read successfully on ten providers; Poloniex stale quotes were excluded and Gate was unavailable. The actual interface was checked at 1,280 px and 390 px with clearly labelled synthetic UI fixtures; RU/EN and all three ledger steps were confirmed.

A synthetic 12,000-quote / 1,000-asset comparison reduced local cold calculation from about 429 ms / 142 MiB heap to 178 ms / 42 MiB after bounded ranking; 100 repeated cached page requests took approximately 0.2 ms with the injected test feed. These are development measurements, not a production concurrency or multi-day uptime guarantee.

## Primary references

- [Poloniex market data and books](https://api-docs.poloniex.com/spot/api/public/market-data), [currency and multi-chain reference](https://api-docs.poloniex.com/spot/api/public/reference-data).
- [Crypto.com Exchange API](https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html), [fee schedule](https://crypto.com/exchange/document/fees-limits).
- [Kraken ticker schema](https://docs.kraken.com/api-reference/market-data/get-ticker-information), [fee schedule](https://www.kraken.com/features/fee-schedule).
- [Bitstamp API](https://www.bitstamp.net/api/), [fee schedule](https://www.bitstamp.net/fee-schedule/).
- [Binance fee schedule](https://www.binance.com/en/fee/trading), [Binance Spot API](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints).
