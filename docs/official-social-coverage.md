# Official project announcements

The **Events → Official channels** tab separates authenticated account ownership
from confirmation of a claim. Social posts never generate confirmed urgent alerts
or dated calendar events merely because an official account posted them.

## Discovery and evidence

`socialRegistry.js` seeds major projects and exchanges, and expands the candidate
set using the free `https://api.llama.fi/protocols` catalog. The catalog is discovery
metadata, not proof of ownership or a complete list of all crypto assets. Projects
are deduplicated by X account, not ticker. The initial live catalog had 3,721
candidates; this is **not** the number of projects actively monitored.

The server fetches project websites and checks actual HTML links. X must match the
catalog/seed account. Telegram and Discord links must occur in navigation, footer
or social sections, excluding article body links, scripts and share buttons.
Official RSS/Atom feeds must be declared on the website and remain on that
website's domain; article links must also belong to the project domain.
Every public record exposes its evidence URL and verification timestamp.

Websites are rechecked daily in batches of 16, at most three concurrent requests.
Unavailable websites retry after six hours. Proof expires after seven days without
successful revalidation. Removed links revoke sources and remove their posts.
Catalog refreshes daily; failure retains the previous registry. The explicit
10,000 candidate bound is exposed as partial coverage if exceeded.

## Readers

- **Telegram:** public `t.me/s/<channel>` previews, no key required. Groups, private
  channels, challenges and channels without a public preview report unavailable.
  Forwarded messages are excluded. Existing Telegram bot updates can deliver
  original posts from website-verified channels faster when the bot has access.
- **X:** API v2 user lookup and user timeline. Requires `NEWS_X_BEARER_TOKEN` with
  access to those endpoints. No token means “not connected”, never a healthy empty
  feed. The source author ID is checked; reposts, quotes and replies are excluded.
- **Discord:** optional `NEWS_DISCORD_BOT_TOKEN` and `NEWS_DISCORD_CHANNELS` JSON.
  The official website invite must resolve to the same guild as the configured
  announcement channel (type 5). An explicit author ID allowlist is mandatory.
  Replies, crossposts and webhooks are excluded. Bot must have access and Message
  Content intent; hidden content and permission failures are reported.
- **Websites:** RSS/Atom explicitly linked on the project website. No guessed feed
  is labelled official. Undated items and off-domain articles are rejected.

X and Discord collectors are implemented but **not operational without external
access credentials/permissions**. The implementation does not purchase API access
or bypass platform login, protection or quotas.

## Quality, freshness and recovery

The feed contains unlock/vesting, market structure/listing/delisting and security
announcements. Promotional contests, giveaways, generic posts, presale tracking
templates and tokenized-stock listings are excluded. This deterministic text
filter is conservative and can miss differently worded announcements, non-English
posts outside supported expressions, images, videos and linked-only X posts. It
does not perform OCR or claim to understand every announcement.

The initial scan reads at most three pages per social source and marks truncated
history explicitly. Later recovery persists pagination state and advances the
completed cursor only after catching up to the prior cursor. At most 24 sources
are polled per 30-second cycle, with a two-minute per-source minimum. Large
registries therefore have a longer actual revisit interval. The UI displays last
successful read time; registered, verified and recently readable counts differ.

Request time, body size, concurrency, retained history and backoff are bounded.
Requests pin validated public DNS addresses and cannot follow off-domain redirects
or send credentials through redirects. HTTP 429 and authentication failures back
off; provider errors preserve last good data and do not advance the cursor.
Shutdown cancels requests. State is persisted atomically to
`node-server/data/official-social.json`; storage errors are visible in the API/UI.

Posts are retained for seven days, at most 2,000 overall and 100 per source, with
retention-limit metadata. Edits to fetched Telegram/Discord messages are reflected,
including removal of newly irrelevant messages. Deleted posts and edits outside
the pages revisited by the provider cannot always be detected. RSS history is
limited by the publisher's feed. The site authenticates the publishing account,
not the factual correctness of all statements made by that account.

Social unlock mentions appear in **Unlocks → schedule review signals**, with
publication time and evidence link. Publication time is never used as unlock time;
no amount is inferred from marketing text. Existing reviewed/aggregator calendar
data retains its own provenance and precision rules.

## API and tests

`/api/events` contains only compact social coverage and unlock leads. The paginated
`/api/events/social` endpoint accepts `search`, `platform`, `topic`, `page` and
`sourcePage`, returning 40 posts and 50 sources maximum per request. Opening a
different filter cancels the previous request; late responses cannot overwrite it.

Run `node --test tests/officialSocial.test.js tests/officialSocialView.test.js`
from `node-server`. The suite exercises evidence boundaries, 1,200-project
discovery, forwarded/quoted content, noise, stale data, backoff, pagination across
polls, cursor durability, cancellation, UI filters and race handling.

Provider references:
- [X user timelines](https://docs.x.com/x-api/posts/timelines/introduction)
- [Discord messages and Message Content access](https://docs.discord.com/developers/resources/message)
- [Telegram public post widget](https://core.telegram.org/widgets/post)

These platform documents do not guarantee availability or schema stability of
Telegram's public preview HTML. Live smoke checks supplement parser fixtures.

Local live check on 2026-09-29: 280 project websites examined, 136 projects with
website-linked accounts, 18 successfully read sources during that scan (before
excluding one comments RSS source). These counts are a sample, not a coverage
guarantee or evidence of a production rollout. Real Telegram publications were
parsed; presale tracking noise discovered in that run was added to regression
fixtures and excluded. Browser verification covered the new tab, source registry
and rendering of real announcements. X/Discord authenticated reads were tested
with fixtures; no live credentials were available in this run.
