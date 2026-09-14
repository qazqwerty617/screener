const { spawnSync } = require('node:child_process');

const root = require('node:path').resolve(__dirname, '../..');
const run = (args, input) => {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
};
const replaceOnce = (source, from, to, label) => {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) throw new Error(`Expected one ${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
};
const replaceFirst = (source, from, to, label) => {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Missing ${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
};
const stage = (file, content) => {
  const hash = run(['hash-object', '-w', '--stdin'], content).trim();
  run(['update-index', '--cacheinfo', `100644,${hash},${file}`]);
};

let html = run(['show', 'HEAD:node-server/public/index.html']);
html = replaceFirst(html, '/js/app.js?v=2089', '/js/app.js?v=2090', 'preloaded app version');
html = replaceOnce(html, '/css/app.css?v=1013', '/css/app.css?v=1014', 'app CSS version');
html = replaceOnce(html, '/js/appearanceThemes.js?v=2', '/js/appearanceThemes.js?v=3', 'theme catalogue version');
html = replaceOnce(html, '/js/app.js?v=2089', '/js/app.js?v=2090', 'deferred app version');
const settingsAnchor = `                        <div class="settings-group">
                            <label>Скринер (список монет)</label>
                            <div class="s-row">
                                <span>Цвет фона и шапки</span>
                                <div class="custom-color-picker" data-picker-id="screener-bg"></div>
                            </div>
                        </div>
`;
const workspaceSettings = `${settingsAnchor}                        <div class="settings-group">
                            <label>Отдельные разделы</label>
                            <div class="s-row">
                                <span>Карта: фон / панели</span>
                                <div class="dual-pickers">
                                    <div class="custom-color-picker" data-picker-id="view-map-bg" title="Фон карты"></div>
                                    <div class="custom-color-picker" data-picker-id="view-map-panel" title="Панели карты"></div>
                                </div>
                            </div>
                            <div class="s-row">
                                <span>Арбитраж: фон / панели</span>
                                <div class="dual-pickers">
                                    <div class="custom-color-picker" data-picker-id="view-arbitrage-bg" title="Фон арбитража"></div>
                                    <div class="custom-color-picker" data-picker-id="view-arbitrage-panel" title="Панели арбитража"></div>
                                </div>
                            </div>
                            <div class="s-row">
                                <span>Формации: фон / карточки</span>
                                <div class="dual-pickers">
                                    <div class="custom-color-picker" data-picker-id="view-formations-bg" title="Фон формаций"></div>
                                    <div class="custom-color-picker" data-picker-id="view-formations-panel" title="Карточки формаций"></div>
                                </div>
                            </div>
                        </div>
`;
html = replaceOnce(html, settingsAnchor, workspaceSettings, 'workspace settings anchor');
stage('node-server/public/index.html', html);

let css = run(['show', 'HEAD:node-server/public/css/app.css']);
css += `

/* Theme-aware surfaces for workspaces that previously kept fixed dark colors. */
[data-appearance-theme] #density-view { background: var(--map-bg, var(--bg)); }
[data-appearance-theme] #density-canvas-wrap { background: var(--map-bg, var(--bg)); }
[data-appearance-theme] #density-toolbar,
[data-appearance-theme] .density-select { background: var(--map-panel, var(--bg2)); }
[data-appearance-theme] #density-view .density-count { background: color-mix(in srgb, var(--ac) 15%, transparent); color: var(--ac); }

[data-appearance-theme] #formations-view { background: var(--formations-bg, var(--bg)); }
[data-appearance-theme] #formations-grid { background: var(--formations-bg, var(--bg)); }
[data-appearance-theme] :is(#formations-toolbar, #formations-pagination, .formations-workspace-controls, .formation-chart-card, .formation-mini-canvas) { background: var(--formations-panel, var(--bg2)); border-color: var(--bd); }
[data-appearance-theme] #formations-toolbar { background: color-mix(in srgb, var(--formations-panel, var(--bg2)) 88%, transparent); }
[data-appearance-theme] .formations-workspace-controls :is(input, button) { background: var(--formations-bg, var(--bg)); border-color: var(--bd); color: var(--t1); }
[data-appearance-theme] :is(.formations-workspace-controls label, .formations-background-status) { color: var(--t2); }
[data-appearance-theme] .formations-background-status strong { color: var(--gr); }
[data-appearance-theme] :is(.fc-overlay-info, .fc-overlay-footer) { background: color-mix(in srgb, var(--formations-panel, var(--bg2)) 88%, transparent); border-color: var(--bd); }
[data-appearance-theme] #formations-view .grid-cell { background: var(--formations-panel); border-color: var(--bd); }
[data-appearance-theme] #formations-view .cell-header { background: var(--formations-panel); border-color: var(--bd); }
[data-appearance-theme] #formations-view :is(.cell-sym, .cell-price) { color: var(--t1); }
[data-appearance-theme] #formations-view .cell-tf { background: var(--bgh); color: var(--t2); }
[data-appearance-theme] #formations-view .cell-fs-btn:hover { background: var(--bgh); color: var(--t1); }
[data-appearance-theme] #formations-view :is(.formations-count, .fc-badge) { background: color-mix(in srgb, var(--ac) 15%, transparent); border-color: color-mix(in srgb, var(--ac) 32%, transparent); color: var(--ac); }

[data-appearance-theme] #arbitrage-view { background: var(--arbitrage-bg); color: var(--t1); }
[data-appearance-theme] #arbitrage-view .arb-hero { background: radial-gradient(700px 180px at 8% 0, var(--acglow), transparent 70%), var(--arbitrage-panel); border-color: var(--bd); }
[data-appearance-theme] #arbitrage-view :is(.arb-kpis article, .arb-filters, .arb-results, .arb-filterbar, .arb-exchange-bar, .arb-table th) { background: var(--arbitrage-panel); border-color: var(--bd); }
[data-appearance-theme] #arbitrage-view :is(.arb-search, .arb-field-row input, .arb-field-row select, .arb-tools select, .arb-tools button, .arb-compact-field input, .arb-compact-field select, .arb-reset-btn, .arb-refresh-btn, .arb-exchange) { background: var(--arbitrage-bg); border-color: var(--bd); color: var(--t1); }
[data-appearance-theme] #arbitrage-view :is(.arb-modebar, .arb-table-top, .arb-exchange-bar, .arb-table th, .arb-table td, .arb-route-leg:first-child, .arb-table-foot) { border-color: var(--bd); }
[data-appearance-theme] #arbitrage-view :is(.arb-page-head h1, .arb-kpis strong, .arb-table-top strong, .arb-filter-head strong, .arb-pair strong, .arb-leg strong, .arb-route-leg strong, .arb-route-leg b) { color: var(--t1); }
[data-appearance-theme] #arbitrage-view :is(.arb-page-head p, .arb-feed-state span, .arb-feed-state strong, .arb-kpis span, .arb-kpis small, .arb-table-top span, .arb-table th, .arb-table td, .arb-muted, .arb-route-leg small, .arb-transfer-mini > span, .arb-table-foot) { color: var(--t2); }
[data-appearance-theme] #arbitrage-view .arb-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--arbitrage-panel) 76%, var(--arbitrage-bg)); }
[data-appearance-theme] #arbitrage-view .arb-table tbody tr:hover { background: var(--bgh); }
[data-appearance-theme] #arbitrage-view .arb-modes button.on { color: var(--t1); border-color: var(--ac); }
[data-appearance-theme] #arbitrage-view :is(.arb-page-head h1 em, .arb-eyebrow, .arb-filter-head button, .arb-filter-label button, .arb-exchange-bar > button) { color: var(--ac); }
[data-appearance-theme] #arbitrage-view .arb-modes button.on b { background: color-mix(in srgb, var(--ac) 20%, transparent); color: var(--ac); }
[data-appearance-theme] #arbitrage-view .arb-check input:checked + i { background: var(--ac); }
[data-appearance-theme] #arbitrage-view .arb-coin { background: var(--bg3); color: var(--ac); }
[data-appearance-theme] #arbitrage-view .arb-score-ring { background: conic-gradient(var(--ac) calc(var(--score) * 1%), var(--bd) 0); }
[data-appearance-theme] #arbitrage-view .arb-score-ring::before { background: var(--arbitrage-panel); }
[data-appearance-theme] :is(.arb-drawer, .arb-detail-score, .arb-detail-chart, .arb-detail-leg) { background: var(--arbitrage-panel); border-color: var(--bd); color: var(--t1); }
[data-appearance-theme] .arb-drawer :is(h2, strong, .arb-breakdown b) { color: var(--t1); }
[data-appearance-theme] .arb-drawer :is(p, span, .arb-breakdown div) { color: var(--t2); }
[data-appearance-theme] .arb-drawer :is(.arb-breakdown, .arb-drawer > header) { border-color: var(--bd); }
`;
stage('node-server/public/css/app.css', css);
