const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const specs = [
  ['app.js', 'node-server/public/js/app.js'],
  ['index.html', 'node-server/public/index.html'],
  ['app.css', 'node-server/public/css/app.css'],
];

for (const [name, target] of specs) {
  const before = `.scratch/theme-workspaces/before/${name}`;
  const result = spawnSync('git', ['diff', '--no-index', '--binary', '--unified=3', '--', before, target], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || `git diff failed for ${name}`);
  let patch = result.stdout;
  patch = patch
    .replace(`a/${before}`, `a/${target}`)
    .replace(`--- a/${before}`, `--- a/${target}`);
  fs.writeFileSync(path.join(__dirname, `${name}.patch`), patch);
}
