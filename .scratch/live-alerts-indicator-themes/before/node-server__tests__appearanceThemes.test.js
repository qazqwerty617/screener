const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/appearanceThemes.js'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const backtestSource=fs.readFileSync(path.join(__dirname,'../public/js/backtest.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../public/css/app.css'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
test('every complete palette has an accurate chart, screener and volume preview',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.eval(source);
  const {themes,preview,applyShell}=dom.window.AppearanceThemes;
  assert.equal(themes.length,7);
  for(const theme of themes){
    applyShell(theme.id);
    const style=dom.window.document.documentElement.style;
    assert.equal(style.getPropertyValue('--bg'),theme.bg);
    assert.equal(style.getPropertyValue('--screener-bg'),theme.panel);
    assert.equal(style.getPropertyValue('--t1'),theme.text);
    const svg=preview(theme);
    for(const key of ['up','down','volumeUp','volumeDown','panel','bg','wickUp','wickDown']) assert.ok(svg.includes(theme[key]),key);
    assert.notEqual(theme.up,theme.down);
  }
  assert.equal(dom.window.AppearanceThemes.get('silver').light,true);
  assert.deepEqual(JSON.parse(JSON.stringify(themes[0])), {
    id:'obsidian', name:'Obsidian Original', description:'Оригинальная · фирменный фиолетовый',
    bg:'#0d0f14', panel:'#13151e', raised:'#181b26', hover:'#1e2235', text:'#d1d4dc',
    muted:'#6b7080', border:'#2b2e39', accent:'#7c3aed', onAccent:'#ffffff', up:'#26c97a',
    down:'#ff4560', wickUp:'#26c97a', wickDown:'#ff4560', volumeUp:'#26c97a',
    volumeDown:'#ff4560', grid:'#1c1f27', mapBg:'#04050d', mapPanel:'#0d0f14',
    arbitrageBg:'#080a0f', arbitragePanel:'#0d1016', formationsBg:'#0d0f14',
    formationsPanel:'#11131c', light:false
  });
  dom.window.close();
});

test('unknown or retired theme ids fall back to original Obsidian',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.localStorage.setItem('screener-appearance-theme','retired-theme');
  dom.window.eval(source);
  assert.equal(dom.window.document.documentElement.dataset.appearanceTheme,'obsidian');
  assert.equal(dom.window.document.documentElement.style.getPropertyValue('--bg'),'#0d0f14');
  dom.window.close();
});

test('migrates the accidentally automatic Aurora default back to Obsidian once',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.localStorage.setItem('screener-appearance-theme','aurora');
  dom.window.eval(source);
  assert.equal(dom.window.localStorage.getItem('screener-appearance-theme'),'obsidian');
  assert.equal(dom.window.document.documentElement.dataset.appearanceTheme,'obsidian');
  dom.window.close();
});

test('theme cards use a compact four-column preview grid',()=>{
  assert.match(css,/\.theme-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css,/\.theme-opt svg \{[^}]*height: 72px;/);
});

test('every palette styles map, arbitrage and formations workspaces',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.eval(source);
  for(const theme of dom.window.AppearanceThemes.themes){
    for(const key of ['mapBg','mapPanel','arbitrageBg','arbitragePanel','formationsBg','formationsPanel']) {
      assert.match(theme[key] || '', /^#[0-9a-f]{6}$/i, `${theme.id}.${key}`);
    }
    dom.window.AppearanceThemes.applyShell(theme.id);
    const style=dom.window.document.documentElement.style;
    for(const [cssVar,key] of [['--map-bg','mapBg'],['--map-panel','mapPanel'],['--arbitrage-bg','arbitrageBg'],['--arbitrage-panel','arbitragePanel'],['--formations-bg','formationsBg'],['--formations-panel','formationsPanel']]) {
      assert.equal(style.getPropertyValue(cssVar),theme[key]);
    }
  }
  dom.window.close();
});

test('appearance settings expose background and panel colors for all three workspaces',()=>{
  for(const id of ['view-map-bg','view-map-panel','view-arbitrage-bg','view-arbitrage-panel','view-formations-bg','view-formations-panel']) {
    assert.match(html,new RegExp(`data-picker-id="${id}"`),id);
  }
  assert.match(css,/#density-view\s*\{[^}]*var\(--map-bg/s);
  assert.match(css,/#arbitrage-view\s*\{[^}]*var\(--arbitrage-bg/s);
  assert.match(css,/#formations-view\s*\{[^}]*var\(--formations-bg/s);
  assert.match(appSource,/getPropertyValue\("--map-bg"\)/);
  assert.match(appSource,/getCanvasBgColorFor\(this\.canvas\)/);
});

test('candle borders stay enabled at compact zoom levels',()=>{
  assert.doesNotMatch(appSource,/border\.show\s*&&\s*candleW\s*>\s*10/);
  assert.doesNotMatch(appSource,/border\.show\s*&&\s*candleWidth\s*>\s*10/);
  assert.match(appSource,/strokeRect\(strokeLeftX, strokeTopY, strokeW, strokeH\)/);
  assert.match(backtestSource,/strokeRect\(fillX, fillY, fillW, fillH\)/);
});

test('palette contrast helper repairs unreadable text colors',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.eval(source);
  const {contrastRatio,ensureReadableColor}=dom.window.AppearanceThemes;
  assert.ok(contrastRatio('#232b35','#edf0f3') >= 4.5);
  assert.equal(ensureReadableColor('#232b35','#edf0f3'),'#232b35');
  const repaired=ensureReadableColor('#edf0f3','#edf0f3');
  assert.ok(contrastRatio(repaired,'#edf0f3') >= 4.5);
  assert.notEqual(repaired.toLowerCase(),'#edf0f3');
  for(const theme of dom.window.AppearanceThemes.themes){
    dom.window.AppearanceThemes.applyShell(theme.id);
    const style=dom.window.document.documentElement.style;
    for(const [textVar,bg] of [['--map-text',theme.mapPanel],['--map-muted',theme.mapPanel],['--arbitrage-text',theme.arbitragePanel],['--arbitrage-muted',theme.arbitragePanel],['--formations-text',theme.formationsPanel],['--formations-muted',theme.formationsPanel]]) {
      assert.ok(contrastRatio(style.getPropertyValue(textVar),bg) >= 4.5,`${theme.id} ${textVar}`);
    }
  }
  dom.window.close();
});

test('chart and workspace labels use their rendered background for contrast',()=>{
  assert.match(appSource,/function getAxisTextColor\(background = getCanvasBgColor\(\)\)/);
  assert.match(appSource,/getAxisTextColor\(cellBackground\)/);
  assert.match(backtestSource,/getAxisTextColor\(background\)/);
  for(const cssVar of ['--map-text','--map-muted','--arbitrage-text','--arbitrage-muted','--formations-text','--formations-muted']) {
    assert.ok(css.includes(`var(${cssVar}`),cssVar);
  }
});
test('saved palette restores the whole shell on page startup',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.localStorage.setItem('screener-appearance-theme','silver');
  dom.window.eval(source);
  assert.equal(dom.window.document.documentElement.dataset.appearanceTheme,'silver');
  assert.equal(dom.window.document.documentElement.style.colorScheme,'light');
  dom.window.close();
});
