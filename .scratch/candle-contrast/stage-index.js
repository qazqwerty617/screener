const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

function fromHead(path) {
  return execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
}

function replaceOnce(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one match, found ${count}: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}

let css = fromHead('node-server/public/css/app.css');
const cssReplacements = [
  ['[data-appearance-theme] .formations-workspace-controls :is(input, button) { background: var(--formations-bg, var(--bg)); border-color: var(--bd); color: var(--t1); }', '[data-appearance-theme] .formations-workspace-controls :is(input, button) { background: var(--formations-bg, var(--bg)); border-color: var(--bd); color: var(--formations-text, var(--t1)); }'],
  ['[data-appearance-theme] :is(.formations-workspace-controls label, .formations-background-status) { color: var(--t2); }', '[data-appearance-theme] :is(.formations-workspace-controls label, .formations-background-status) { color: var(--formations-muted, var(--t2)); }'],
  ['[data-appearance-theme] #formations-view :is(.cell-sym, .cell-price) { color: var(--t1); }', '[data-appearance-theme] #formations-view :is(.cell-sym, .cell-price) { color: var(--formations-text, var(--t1)); }'],
  ['[data-appearance-theme] #formations-view .cell-tf { background: var(--bgh); color: var(--t2); }', '[data-appearance-theme] #formations-view .cell-tf { background: var(--bgh); color: var(--formations-muted, var(--t2)); }'],
  ['[data-appearance-theme] #formations-view .cell-fs-btn:hover { background: var(--bgh); color: var(--t1); }', '[data-appearance-theme] #formations-view .cell-fs-btn:hover { background: var(--bgh); color: var(--formations-text, var(--t1)); }'],
  ['[data-appearance-theme] #arbitrage-view { background: var(--arbitrage-bg); color: var(--t1); }', '[data-appearance-theme] #arbitrage-view { background: var(--arbitrage-bg); color: var(--arbitrage-text, var(--t1)); }'],
  ['[data-appearance-theme] #arbitrage-view :is(.arb-search, .arb-field-row input, .arb-field-row select, .arb-tools select, .arb-tools button, .arb-compact-field input, .arb-compact-field select, .arb-reset-btn, .arb-refresh-btn, .arb-exchange) { background: var(--arbitrage-bg); border-color: var(--bd); color: var(--t1); }', '[data-appearance-theme] #arbitrage-view :is(.arb-search, .arb-field-row input, .arb-field-row select, .arb-tools select, .arb-tools button, .arb-compact-field input, .arb-compact-field select, .arb-reset-btn, .arb-refresh-btn, .arb-exchange) { background: var(--arbitrage-bg); border-color: var(--bd); color: var(--arbitrage-text, var(--t1)); }'],
  ['[data-appearance-theme] #arbitrage-view :is(.arb-page-head h1, .arb-kpis strong, .arb-table-top strong, .arb-filter-head strong, .arb-pair strong, .arb-leg strong, .arb-route-leg strong, .arb-route-leg b) { color: var(--t1); }', '[data-appearance-theme] #arbitrage-view :is(.arb-page-head h1, .arb-kpis strong, .arb-table-top strong, .arb-filter-head strong, .arb-pair strong, .arb-leg strong, .arb-route-leg strong, .arb-route-leg b) { color: var(--arbitrage-text, var(--t1)); }'],
  ['[data-appearance-theme] #arbitrage-view :is(.arb-page-head p, .arb-feed-state span, .arb-feed-state strong, .arb-kpis span, .arb-kpis small, .arb-table-top span, .arb-table th, .arb-table td, .arb-muted, .arb-route-leg small, .arb-transfer-mini > span, .arb-table-foot) { color: var(--t2); }', '[data-appearance-theme] #arbitrage-view :is(.arb-page-head p, .arb-feed-state span, .arb-feed-state strong, .arb-kpis span, .arb-kpis small, .arb-table-top span, .arb-table th, .arb-table td, .arb-muted, .arb-route-leg small, .arb-transfer-mini > span, .arb-table-foot) { color: var(--arbitrage-muted, var(--t2)); }'],
  ['[data-appearance-theme] #arbitrage-view .arb-modes button.on { color: var(--t1); border-color: var(--ac); }', '[data-appearance-theme] #arbitrage-view .arb-modes button.on { color: var(--arbitrage-text, var(--t1)); border-color: var(--ac); }'],
  ['[data-appearance-theme] :is(.arb-drawer, .arb-detail-score, .arb-detail-chart, .arb-detail-leg) { background: var(--arbitrage-panel); border-color: var(--bd); color: var(--t1); }', '[data-appearance-theme] :is(.arb-drawer, .arb-detail-score, .arb-detail-chart, .arb-detail-leg) { background: var(--arbitrage-panel); border-color: var(--bd); color: var(--arbitrage-text, var(--t1)); }'],
  ['[data-appearance-theme] .arb-drawer :is(h2, strong, .arb-breakdown b) { color: var(--t1); }', '[data-appearance-theme] .arb-drawer :is(h2, strong, .arb-breakdown b) { color: var(--arbitrage-text, var(--t1)); }'],
  ['[data-appearance-theme] .arb-drawer :is(p, span, .arb-breakdown div) { color: var(--t2); }', '[data-appearance-theme] .arb-drawer :is(p, span, .arb-breakdown div) { color: var(--arbitrage-muted, var(--t2)); }']
];
for (const [before, after] of cssReplacements) css = replaceOnce(css, before, after);
css = replaceOnce(
  css,
  '[data-appearance-theme] #density-view .density-count { background: color-mix(in srgb, var(--ac) 15%, transparent); color: var(--ac); }',
  '[data-appearance-theme] #density-view { color: var(--map-text, var(--t1)); }\n[data-appearance-theme] :is(#density-toolbar, .density-select) { color: var(--map-text, var(--t1)); }\n[data-appearance-theme] #density-view :is(.density-sub, .density-stat-label, .density-legend, .density-toolbar label) { color: var(--map-muted, var(--t2)); }\n[data-appearance-theme] #density-view .density-count { background: color-mix(in srgb, var(--ac) 15%, transparent); color: var(--ac); }'
);
writeFileSync('.scratch/candle-contrast/staged-app.css', css);

let html = fromHead('node-server/public/index.html');
for (const [before, after] of [['app.js?v=2090','app.js?v=2091'],['app.css?v=1014','app.css?v=1015'],['appearanceThemes.js?v=3','appearanceThemes.js?v=4'],['backtest.js?v=2010','backtest.js?v=2011']]) {
  const expected = before.startsWith('app.js') ? 2 : 1;
  const count = html.split(before).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} matches, found ${count}: ${before}`);
  html = html.split(before).join(after);
}
writeFileSync('.scratch/candle-contrast/staged-index.html', html);
