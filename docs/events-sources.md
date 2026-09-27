# Events: sources and publication policy

Updated on 2026-09-27. This is automatic source corroboration, not a guarantee that a reported event is true.

## News

Tree News remains the streaming input. The publisher name supplied in a stream message is not evidence of identity. For a supported publisher URL, the server fetches the article and reads its own headline and publication date; it does not reuse the stream headline as a verified claim. Social posts and unknown URLs remain leads.

The polling pool includes CoinDesk, Cointelegraph, The Block, Decrypt, DL News, Blockworks, Federal Reserve monetary policy, White House presidential actions and official announcements from Binance, Bybit, Bitget and Gate. RSS and Atom are supported. Polling is every 20 seconds; an urgent lead can trigger an earlier check, limited to once per 10 seconds. Sources publish independently. Concurrent requests for the same URL share one operation; conditional requests reuse unchanged feeds and failures back off. Responses have time and size limits. HTTP success with no articles in the last seven days is shown separately from a current feed. Promotions and unrelated technology headlines are filtered. Binance's public CMS endpoint is a website dependency, not a guaranteed exchange API contract.

Before appearing as a sourced report in the public feed, an ordinary article needs an authenticated publisher URL and a fresh date from that publisher. This is labelled as a single-source report. Sourced security, solvency and market-moving reports awaiting independent evidence remain visible in “Требует подтверждения”, with their links; they do not trigger urgent notifications. A confirmed urgent alert needs:

- An authenticated official statement on an allowed official page, about the publisher's own action or incident; or
- Two supported publishers reporting a matching claim within two hours. Matching requires shared subject, headline overlap, compatible amounts/numbers and action direction. Headlines that look like rumours, verbatim copies, explicit wire attribution or different amounts do not qualify.

Reworded syndicated reports without attribution can still evade automatic checks; the UI distinguishes single-source reporting, official statements and “Сверено по 2 источникам” and links to the evidence rather than a guarantee of truth. A detected denial removes matching publications and retracts their open toast. Corrections supersede old headlines; late translations cannot restore withdrawn text. There is no semantic model or manual fact checker behind this implementation. Failed headline translations retry after a minute when a feed repeats the article. DeepL can be configured with `DEEPL_API_KEY`; the default public MyMemory service has no delivery guarantee.

Evidence identity is derived from the publisher URL and an actual fetched feed/article. Binance Square and other user-generated pages on official domains are excluded. Previously stored unverified headlines are not published automatically. Only fresh corroborated events qualify for toasts; translation does not delay initial publication after verification.

Telegram ingestion uses the existing bot's `channel_post` and `edited_channel_post` updates. Set `NEWS_TELEGRAM_CHANNEL_IDS` to the selected numeric channel IDs and add the bot to those channels. This does not provide access to arbitrary third-party channels. A selected channel is still only a lead; links to supported publishers can be checked immediately. No Telegram channels are selected by default.

## Listings and delistings

All eleven configured exchanges are scanned for USDT spot and perpetual markets every 90 seconds. Gate, MEXC, Aster and Hyperliquid receive additional scans at the intervening 30-second ticks. KuCoin now loads both `kucoin` and `kucoinfutures`; its futures catalogue was previously absent. Gate's catalogue loading excludes options, delivery futures and currency-network metadata. Each client has a 30-second catalogue deadline, and overlapping callers share an unfinished request.

New undated markets require two successful scans; disappearing markets require three. An error breaks confirmation but retains missing keys for a later healthy scan. Bulk catalogue loss remains an error, not a mass delisting. Disappearance is explicitly labelled as an observation, not an official delisting date.

Future inactive markets with a supported launch timestamp are retained. Historical timestamps are seeded only for Binance, Bybit and OKX. Known future launch times are updated if the exchange changes them. OKX's continuous-trading start is preferred to its call-auction start when provided.

Official scheduled removal dates are read from Bybit perpetual `deliveryTime`, OKX `expTime` and Gate spot `delisting_time`. Calendar placement uses the removal date, not the time the scanner discovered the schedule. A schedule removed before its effective time is retracted. This is catalogue-based tracking; it does not parse all eleven exchanges' announcement websites or promise every future listing before API publication.

The separate official-announcement list includes Binance listing/futures categories, Bybit new-crypto/delisting categories, Bitget listing/delisting notices and relevant Gate announcements. Publication time is never substituted for trading launch time. Catalog scanning and announcements complement each other; neither guarantees complete coverage. Search and the exchange/event-kind filters also apply to announcements. Catalog market-type/date filters require structured market data and apply to the calendar.

## Unlocks

The calendar has search, 30/90/365-day and past-90-day views, pagination, token amounts, allocation groups, source links and explicit coverage status. It describes scheduled vesting, not executed on-chain transfers or a prediction of selling.

Without credentials, reviewed primary schedules cover **XPL, ARB and APT only**, reviewed 2026-09-26. Dates have day precision; UTC midnight is a calendar key, not an execution time. Percentages refer to the published supply basis, not necessarily current circulating supply. Primary schedules are versioned code and need review if a project changes its tokenomics. ARB's historical initial cliff and XPL public-sale quantities are not fabricated where this implementation lacks a modeled amount.

- XPL: ecosystem allocation over 36 months; team/investor one-third cliff after 12 months and the remaining two-thirds over the next 24 months.
- ARB: monthly team/investor vesting after the initial year, through March 2027.
- APT: community/foundation monthly distribution and team/investor vesting ending October 2026.

An optional server-only `DEFILLAMA_API_KEY` enables the Pro `/api/emissions` adapter. This is additional aggregated coverage with separate provenance. The adapter accepts documented explicit cliffs; it never turns linear emission rates into lump-sum unlocks. Refresh is shared across users, at most once per 30 minutes, with a five-minute error backoff. Data is labelled stale after one hour and removed after 24 hours; primary schedules remain available. Credentials and raw provider errors never appear in public status. The live paid response has not been tested without an entitled key; fixtures exercise the documented schema, expiry and failure behavior. No Tokenomist integration is claimed.

## Runtime behavior

Ordinary SSE update bursts coalesce over 500 ms on the server and client; urgent, retraction and translation events are immediate. Stalled streams are closed with bounded queued output and release both timers and the subscription. Hidden pages skip ordinary refreshes. Only the active Events panel is rendered, and large lists are paginated. Last data survives request errors with an offline label. Persistence is debounced and serialized through asynchronous temporary-file writes, and pending state is flushed on server shutdown. Saved news is reassessed with the current classifier when the process starts.

## Live checks

All eleven exchange catalogues eventually responded from the development machine. KuCoin returned both spot and perpetual USDT markets after the fix. Hyperliquid returned eligible USDT spot markets and no USDT perpetuals; non-USDT markets remain excluded. Gate was exceptionally slow: its CCXT catalogue completed after roughly 268 seconds, while direct requests exceeded a seven-second timeout. The new 30-second deadline prevents such a wait from blocking scans; a late successful result can be consumed by the next scan if still fresh. A provider error is exposed rather than replaced with fabricated listings.

On 2026-09-27 the expanded polling run returned 124 public reports, 18 developing reports and 27 relevant official listing announcements in the isolated preview (counts are observations, not minimum service guarantees). Reports about the Bitget incident were visible with their original sources and uncertainty labels. Binance, Bybit, Bitget and Gate APIs responded. DL News and Blockworks returned parseable but old articles; Federal Reserve and White House feeds had no items within this seven-day window. The status reflects that rather than calling old articles current. Production availability and provider account entitlements still require checks in the deployment environment.

## Primary documentation

- [Tree News streaming connection](https://docs.treeofalpha.com/websockets/javascript-connection)
- [Telegram bot access to channel messages](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)
- [Federal Reserve feeds](https://www.federalreserve.gov/feeds/feeds.htm)
- [Bybit instrument launch and perpetual delisting timestamps](https://bybit-exchange.github.io/docs/v5/market/instrument)
- [Bybit announcements](https://bybit-exchange.github.io/docs/v5/announcement)
- [Bitget announcements](https://www.bitget.com/api-doc/common/public/Get-Announcements)
- [OKX instrument listing and delisting updates](https://www.okx.com/docs-v5/log_en/)
- [Gate spot delisting and public market API](https://www.gate.com/docs/developers/apiv4/en/)
- [Gate public announcement API](https://github.com/gate/gateapi-python/blob/master/docs/AnnouncementApi.md)
- [CertiK security alert channels](https://www.certik.com/blog/top-tips-for-keeping-up-with-the-latest-crypto-security-events) — candidate for a separately configured source; not presented as connected.
- [Plasma token distribution](https://www.plasma.org/company/blog/xpl-the-public-sale-and-its-role-in-the-plasma-ecosystem)
- [Plasma mainnet date](https://www.plasma.org/company/blog/plasma-mainnet-beta-and-xpl)
- [Arbitrum distribution](https://docs.arbitrum.foundation/airdrop-eligibility-distribution)
- [Aptos tokenomics](https://aptosnetwork.com/currents/aptos-tokenomics-overview)
- [DefiLlama official SDK and emissions types](https://github.com/DefiLlama/api-sdk)
