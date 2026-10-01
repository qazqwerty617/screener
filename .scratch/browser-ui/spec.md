# Browser alerts, language and rendering

Fix literal markup in price/formation toasts; keep safe text rendering and chart navigation.
Add persistent RU/EN settings accessible to all plans; preserve PRO appearance gates.
Reduce offscreen rendering and bound the composite density canvas without skipping data ingestion.
Formation notifications must honor selections after account refresh and explicit Telegram disable.

Validation: browserResourceAudit, i18n, formationAlertsUi, formationSubscriberPrefs, full Node suite; local browser fixture with real frontend assets (not a live exchange/deployment check).

Additional regressions: late or malformed density snapshots must not replace newer accepted data; initial filter controls and migrated preferences must match the actual calculation; translated navigation must use stable view identifiers and dispatch once per click.
