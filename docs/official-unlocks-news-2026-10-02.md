# News and official unlock coverage audit — 2026-10-02

## Reproduced news failure

Four authenticated publishers can describe the same incident with different verbs and mention unrelated past incidents. The previous all-capitalized-subject and headline-overlap comparison left the NEAR Intents-style reports in the developing feed. A denial about Bitget in contextual text could also interfere with another victim's report.

The regression fixtures reproduce the screenshot's headline structures; their URLs are deliberately synthetic and are not claims that those article pages were fetched. They now yield one urgent incident with four independent evidence links and one alert. Matching retains the two-hour window, authenticated publisher identity, distinct sources, compatible loss/outcome, denial handling and exclusions for rumours, copies and wire attribution. An urgent feed may still legitimately be empty when no qualifying fresh evidence is available. This change does not manufacture urgent news or establish truth independently of publishers.

## Actual primary-source audit

On this development machine, the free Upbit catalog exposed **358 distinct assets**. All metadata entries were checked, and all **238 published project-team PDF plans** were decoded with the audited table-parsing rules. The source's project-team provenance follows [Upbit's official information policy](https://support.upbit.com/hc/en-us/articles/14657848162329-Digital-Asset-Information-Tab).

After excluding an obsolete ZRO plan and a JUP plan needing review, the bundled dated snapshot has **236 usable documents**, **193 projects with future positive monthly entries**, and **120 assets with no published plan**. All 358 catalog entries were checked; request/parse errors in this observation were zero. These are dated observations, not guaranteed minimums or universal cryptocurrency coverage.

Reviewed formulas now cover **10 projects**: XPL, ARB, APT, STRK, ZK, TIA, BERA, ZRO, PYTH and ONDO. Combining them with team plans gives **198 distinct projects with future official-source entries** on 2026-10-02. The counts overlap; 10 + 193 is not the unique coverage count.

## What the data means

- Reviewed formulas model only the allocations documented in the implementation. STRK/ZK maximums are labelled as upper bounds. PYTH/ONDO stage amounts remain unknown where the sources do not establish them. TIA/BERA continuous vesting is integrated over periods.
- A team PDF predicts month-end circulating supply. The difference between adjacent months can include vesting, emissions and other releases. It is shown as a monthly forecast, separately from the calendar's dated unlocks. Neither an exact release date nor a sale is inferred.
- Checking that a document is still published establishes retrieval freshness, not a guarantee that all its assumptions remain current. Known later changes are handled explicitly, but automatic detection of every future project amendment is not implemented.
- The [June 2026 ZRO revision](https://layerzero.network/blog/the-zro-token) supersedes its older PDF. [W's September 2025 change](https://wormhole.com/blog/wormhole-announces-w-token-2-0-upgrade) and [IP's August 2026 lockup extension](https://www.datafdn.org/blog/extending-the-data-lockup-building-from-proven-ground) are also registered; documents older than their new terms cannot restore obsolete forecasts.
- JUP's January PDF predates the [official team's February net-zero proposal](https://discuss.jup.ag/t/proposal-net-zero-emissions/39948). It is hidden as **review required**. That primary source is a proposal, so the implementation does not claim its vote passed or infer a replacement numeric schedule.

## Runtime and verification

The server scans progressively without an asset-count cap, sharing refresh work across users. Request pacing, bounded bodies, Retry-After backoff, atomic persistence, daily checks and conditional PDF responses bound repeated work. At most two PDF workers decode text off the event loop; no PDF decoding is shipped to the browser. Worker heap/time/page/item limits prevent unbounded documents. Cached source status distinguishes missing plans, unsupported formats, failures, superseded/review-required plans and staleness. Plans older than 72 hours without a successful recheck are hidden. The initial seed has the same expiry, not a refreshed timestamp at startup.

Tests cover incident matching and exclusions, end-to-end urgent deduplication, schedule arithmetic and end dates, unknown amounts, continuous vesting totals, PDF date/quantity alignment including rotated pages, conflicting/ambiguous/malformed data, safe origins and asset identity, progressive coverage, concurrent refreshes, rate-limit recovery, persistence/ETag reuse, expiry, actual worker decoding and public-seed integrity. UI checks cover official defaults, source/type filters, month/day separation, pagination and explicit review warnings.

The full Node suite passed **1070/1070 tests**, with zero failures or skips. Syntax checks passed for the nine changed runtime scripts; `npm audit` reported zero known dependency vulnerabilities after compatible Undici/brace-expansion updates. These are automated checks, not proof that every function of the entire product is perfect.

An isolated local browser preview used the actual Events HTML/CSS/client scripts, real parsed public schedules and explicitly labelled synthetic news fixtures. It confirmed a four-source urgent card, official-source defaults, JUP/ZRO warnings, search, monthly navigation, 100-card pagination (the following page contained 80 of 180 October periods), and Russian/English controls and card metadata. At a 390px viewport, the SUI monthly forecast card and warnings fit without page overflow; the seven-column calendar has its own horizontal scroll. No production alert was sent.

## Remaining limits

The exchange catalog does not contain every cryptoasset, and 120 catalog assets did not publish a plan at the time of inspection. Some published plans end before the current date or forecast zero monthly changes. Free endpoints and document formats can change or become unavailable; those failures are exposed. This work does not imply complete X/Telegram/Discord monitoring, independently verified on-chain execution, entitled paid API coverage, deployment to production or a multi-day production load test.
