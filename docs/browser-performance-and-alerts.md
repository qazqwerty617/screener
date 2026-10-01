# Browser rendering and notification audit

Price alerts previously passed HTML to a toast component that deliberately uses
`textContent`. The markup consequently appeared in the message. Callers now pass
plain text and a separate keyboard-accessible chart action. The component still
does not execute markup. The drawing-alert branch also referenced an unrelated
saved-alert variable; it now captures its own market identifiers.

Browser feedback, persistence and drawing removal finish synchronously before
Telegram image generation. A slow snapshot cannot postpone the browser alert or
remove drawings from a subsequently selected market. Delayed delivery checks
account ownership. Price matching uses the normalized complete symbol and venue;
ETH alerts do not trigger on WETH. Non-finite prices are rejected.

## Formation preferences

Controls captured the formation-settings object. Account refresh and modal API
responses replaced that object, leaving handlers editing an obsolete copy. The
settings object now retains its identity and account refresh updates the controls.
Pending local writes retain priority over older server responses. Failed saves
have a visible status and remain pending for retry.

The Telegram subscriber collector also treated explicitly disabled destinations
as unconfigured, allowing the administrator fallback to send all formation types
and venues. Known destinations now retain their ownership when disabled. A
standalone destination must explicitly enable Telegram delivery.

## Rendering budget

- Chart invalidations coalesce into the existing render loop, at most 30 paints
  per second. Hidden tabs retain pending chart invalidation without painting.
- Hidden screener tables skip DOM updates. Ingestion and alert evaluation still
  use real prices in the stream handlers. Only visible grid markets interpolate.
- Grid refreshes respect visibility and dirty state; old table rows and their
  flash timers are removed when they leave the retained list.
- Density bubbles render into one reusable composite canvas when data, filters
  or layout change. Radar animation blits it and renders hover/selection live.
  Its pixel buffer is bounded to 32 MiB, including at 4K/high DPR. This bound is
  **not** a bound on total browser or GPU memory.
- A regression runs the actual badge-rendering block with 1,000 walls across 30
  unchanged radar frames: 1,000 bubble renders, compared with 30,000 in the
  previous implementation. Updating the source invalidates the layer. This is an
  operation-count check, not a measured CPU percentage or whole-app speedup.
- Timestamp validation prevents late HTTP fallback or malformed WebSocket
  snapshots from replacing newer accepted walls. Valid newer snapshots and
  authoritative empty snapshots still apply.
- Initial density controls now reflect the actual filter values. The migration
  from the old 3% band to 5% is persisted and survives a second load.

## Language and navigation

Settings → General offers Russian and English on all plans. The choice persists
on the current device. Existing appearance settings retain their PRO gate.
Static controls, accessible labels, common dynamic messages and map tooltips use
local translations; exchange symbols, user-entered text and source publications
remain intact. English event titles prefer the original source title. Dates use
the selected locale.

Russian mode has no translation mutation observer. English mode processes changed
subtrees and relevant attributes rather than rescanning the document per tick;
numeric text updates take a fast path. View selection uses stable identifiers,
independent of translated tab names. A duplicate navigation listener was removed
because the existing HTML click handler already opened the view.

## Validation and limits

Regression tests exercise the actual alert, preference, density transport and
rendering paths, plus a 50,000-market dirty-table burst, large-map layout, 4K/DPR
resizes, delayed delivery, filter synchronization and language round trips. The
complete Node test suite is run after the final code changes.

The local browser check uses production frontend assets with a fixture backend:
six pushed formation signals across Binance/Bybit and three types produce only
the selected Binance trendline alert after account refresh. Settings persist
through reload. Price toasts contain no literal HTML. Search, side filtering and
reset work on a 24-wall fixture. The fixture does not send production Telegram
messages or establish real exchange connections.

No production deployment, multi-day soak test or CPU/RAM measurement on user
hardware was performed in this audit. It does not certify every screen under all
conditions. Official-source discovery and provider limitations are documented
separately in [official-social-coverage.md](official-social-coverage.md).
