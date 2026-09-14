const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/appearanceThemes.js'),'utf8');
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
    volumeDown:'#ff4560', grid:'#1c1f27', light:false
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
    assert.equal(style.getPropertyValue('--map-bg'),theme.mapBg);
    assert.equal(style.getPropertyValue('--arbitrage-bg'),theme.arbitrageBg);
    assert.equal(style.getPropertyValue('--formations-bg'),theme.formationsBg);
  }
  dom.window.close();
});

test('appearance settings expose colors for all three themed workspaces',()=>{
  for(const id of ['view-map-bg','view-arbitrage-bg','view-formations-bg']) {
    assert.match(html,new RegExp(`data-picker-id="${id}"`),id);
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
