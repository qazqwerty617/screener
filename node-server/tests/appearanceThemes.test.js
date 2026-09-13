const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/appearanceThemes.js'),'utf8');
test('every complete palette has an accurate chart, screener and volume preview',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.eval(source);
  const {themes,preview,applyShell}=dom.window.AppearanceThemes;
  assert.equal(themes.length,4);
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
  dom.window.close();
});
test('saved palette restores the whole shell on page startup',()=>{
  const dom=new JSDOM('<html></html>',{url:'https://local.test',runScripts:'outside-only'});
  dom.window.localStorage.setItem('screener-appearance-theme','silver');
  dom.window.eval(source);
  assert.equal(dom.window.document.documentElement.dataset.appearanceTheme,'silver');
  assert.equal(dom.window.document.documentElement.style.colorScheme,'light');
  dom.window.close();
});
