# Events: sources and publication policy

Reviewed on 2026-09-21. This is automatic source corroboration, not a guarantee that a reported event is true.

## News

Tree News remains the streaming input. The publisher name supplied in a stream message is not evidence of identity. For a supported publisher URL, the server fetches the article and reads its own headline and publication date; it does not reuse the stream headline as a verified claim. Social posts and unknown URLs remain leads.

The polling pool is CoinDesk, Cointelegraph, The Block, Decrypt, Federal Reserve monetary policy, White House presidential actions and Gate's official announcement API. Polling is every 20 seconds; an urgent lead can trigger an earlier check, limited to once per 10 seconds. Each publisher publishes independently, so a slow source cannot hold up another. Conditional HTTP requests reuse unchanged RSS feeds, failures back off, and responses have time and size limits. The feed's refresh interval does not promise an end-to-end news delay. Gate announcements are limited to relevant market changes and events; promotions are excluded.

Before appearing as a sourced report in the public feed, an ordinary article needs an authenticated publisher URL and a fresh date from that publisher. This is labelled as a single-source report. Security, solvency and market-moving alerts need:

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

## Live checks

All eleven exchange catalogues eventually responded from the development machine. KuCoin returned both spot and perpetual USDT markets after the fix. Hyperliquid returned eligible USDT spot markets and no USDT perpetuals; non-USDT markets remain excluded. Gate was exceptionally slow: its CCXT catalogue completed after roughly 268 seconds, while direct requests exceeded a seven-second timeout. The new 30-second deadline prevents such a wait from blocking scans; a late successful result can be consumed by the next scan if still fresh. A provider error is exposed rather than replaced with fabricated listings.

All six RSS endpoints returned parseable current items. CoinDesk redirected its trailing-slash URL; the configured endpoint was corrected to the canonical URL, which returned HTTP 200 and 25 items. Production availability and provider account entitlements must be checked in the deployment environment.

## Primary documentation

- [Tree News streaming connection](https://docs.treeofalpha.com/websockets/javascript-connection)
- [Telegram bot access to channel messages](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)
- [Federal Reserve feeds](https://www.federalreserve.gov/feeds/feeds.htm)
- [Bybit instrument launch and perpetual delisting timestamps](https://bybit-exchange.github.io/docs/v5/market/instrument)
- [OKX instrument listing and delisting updates](https://www.okx.com/docs-v5/log_en/)
- [Gate spot delisting and public market API](https://www.gate.com/docs/developers/apiv4/en/)
- [Gate public announcement API](https://github.com/gate/gateapi-python/blob/master/docs/AnnouncementApi.md)
- [CertiK security alert channels](https://www.certik.com/blog/top-tips-for-keeping-up-with-the-latest-crypto-security-events) — candidate for a separately configured source; not presented as connected.
