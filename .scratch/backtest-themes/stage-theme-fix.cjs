const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const changes = {
  'node-server/public/css/app.css': source => source
    .replace('[data-appearance-theme] .settings-modal { width: 790px; height: 720px;', '[data-appearance-theme] .settings-modal { width: 760px; height: 650px;')
    .replace('[data-appearance-theme] .theme-grid { gap: 12px; }', '[data-appearance-theme] .theme-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }')
    .replace('[data-appearance-theme] .theme-opt { padding: 0 0 12px; overflow: hidden; text-align: left; border-radius: 10px;', '[data-appearance-theme] .theme-opt { min-width: 0; padding: 0 0 8px; overflow: hidden; text-align: left; border-radius: 8px;')
    .replace('[data-appearance-theme] .theme-opt svg { display: block; width: 100%; height: auto;', '[data-appearance-theme] .theme-opt svg { display: block; width: 100%; height: 72px;')
    .replace('.theme-name { display: block; padding: 10px 12px 3px; font-weight: 700; font-size: 13px; }', '.theme-name { display: block; padding: 7px 9px 2px; font-weight: 700; font-size: 11px; }')
    .replace('.theme-description { display: block; padding: 0 12px; font-size: 10px; line-height: 1.5; color: var(--t2); }', '.theme-description { display: block; overflow: hidden; padding: 0 9px; font-size: 9px; line-height: 1.35; color: var(--t2); text-overflow: ellipsis; white-space: nowrap; }')
    .replace('[data-appearance-theme] .theme-grid { grid-template-columns: 1fr; }', '[data-appearance-theme] .theme-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n    [data-appearance-theme] .theme-opt svg { height: 78px; }'),
  'node-server/public/js/app.js': source => source.replace('selectAppearanceTheme("aurora");', 'selectAppearanceTheme("obsidian");'),
  'node-server/public/index.html': source => source
    .replaceAll('app.js?v=2088', 'app.js?v=2089')
    .replace('app.css?v=1012', 'app.css?v=1013')
    .replace('appearanceThemes.js?v=1', 'appearanceThemes.js?v=2'),
};

let patch = '';
for (const [file, transform] of Object.entries(changes)) {
  const original = cp.execFileSync('git', ['show', `HEAD:${file}`], {encoding:'utf8', maxBuffer:5_000_000});
  const changed = transform(original);
  if (changed === original) throw new Error(`No staged transformation for ${file}`);
  const dir = path.join('.scratch', 'backtest-themes', 'theme-fix', path.dirname(file));
  fs.mkdirSync(dir, {recursive:true});
  const before = path.join(dir, 'before-' + path.basename(file));
  const after = path.join(dir, 'after-' + path.basename(file));
  fs.writeFileSync(before, original); fs.writeFileSync(after, changed);
  const diff = cp.spawnSync('git', ['diff', '--no-index', '--', before, after], {encoding:'utf8', maxBuffer:5_000_000});
  if (diff.status > 1) throw new Error(diff.stderr);
  patch += diff.stdout
    .replace(/^diff --git .*$/m, `diff --git a/${file} b/${file}`)
    .replace(/^--- .*$/m, `--- a/${file}`)
    .replace(/^\+\+\+ .*$/m, `+++ b/${file}`);
}
const patchFile = '.scratch/backtest-themes/theme-fix.patch';
fs.writeFileSync(patchFile, patch);
cp.execFileSync('git', ['apply', '--cached', '--check', patchFile], {stdio:'inherit'});
cp.execFileSync('git', ['apply', '--cached', patchFile], {stdio:'inherit'});
