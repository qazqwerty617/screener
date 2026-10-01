'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

test('default Russian startup and repeated language selection do not walk the whole interface',t=>{
  const dom=new JSDOM('<p>Настройки</p>',{url:'http://localhost',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,original=w.document.createTreeWalker.bind(w.document);let walks=0;
  w.document.createTreeWalker=(...args)=>{walks++;return original(...args);};
  for(const file of ['i18n-en.js','i18n.js'])w.eval(fs.readFileSync(path.join(__dirname,'../public/js',file),'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));assert.equal(walks,0);
  w.ObsidianI18n.setLanguage('en');assert.equal(w.document.querySelector('p').textContent,'Settings');
  const translatedWalks=walks;w.ObsidianI18n.setLanguage('en');assert.equal(walks,translatedWalks);
  w.ObsidianI18n.setLanguage('ru');assert.equal(w.document.querySelector('p').textContent,'Настройки');
});
function build(t, markup = html) {
  const dom = new JSDOM(markup, { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  for (const file of ['i18n-en.js', 'i18n.js']) dom.window.eval(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'));
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom.window;
}
test('English covers all static controls, headings, hints and accessible labels', t => {
  const w = build(t); w.ObsidianI18n.setLanguage('en');
  const missing = new Set(), walker = w.document.createTreeWalker(w.document.body, 4);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.parentElement.closest('script,style,[translate="no"]') && /[А-Яа-яЁё]/.test(n.data)) missing.add(n.data.trim().replace(/\s+/g, ' '));
  }
  for (const n of w.document.querySelectorAll('[title],[placeholder],[aria-label]')) for (const a of ['title','placeholder','aria-label']) {
    if (/[А-Яа-яЁё]/.test(n.getAttribute(a))) missing.add(n.getAttribute(a));
  }
  assert.deepEqual([...missing], []);
});

test('language belongs to trader profile and settings open directly on Appearance', t => {
  const w = build(t);
  assert.equal(w.document.querySelector('#profile-modal #profile-language').value, 'ru');
  assert.equal(w.document.querySelector('#settings-modal [data-tab="general"]'), null);
  assert.equal(w.document.querySelector('#tab-general'), null);
  assert.equal(w.document.querySelector('#settings-modal .settings-tab.active').dataset.tab, 'appearance');
  const select = w.document.getElementById('profile-language');
  select.value = 'en'; select.dispatchEvent(new w.Event('change'));
  assert.equal(w.document.documentElement.lang, 'en');
  assert.equal(w.localStorage.getItem('obsidian_language'), 'en');
  select.value = 'ru'; select.dispatchEvent(new w.Event('change'));
  assert.equal(w.document.documentElement.lang, 'ru');
});
test('language switches preserve nested controls, prices and user content', async t => {
  const w = build(t, '<label>Настройки <button id="b">Сохранить</button></label><span id="price">123.456</span><p translate="no">Новости</p><input value="Моя заметка" placeholder="Введите имя..."><select id="profile-language"><option value="ru">Русский</option><option value="en">English</option></select>');
  let clicks = 0; w.document.getElementById('b').onclick = () => clicks++;
  w.ObsidianI18n.setLanguage('en');
  assert.equal(w.document.getElementById('b').textContent, 'Save');
  assert.equal(w.document.documentElement.lang, 'en');
  assert.equal(w.localStorage.getItem('obsidian_language'), 'en');
  assert.equal(w.document.querySelector('input').value, 'Моя заметка');
  assert.equal(w.document.querySelector('p').textContent, 'Новости');
  assert.equal(w.document.getElementById('price').textContent, '123.456');
  w.document.getElementById('b').textContent = 'Закрыть';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.document.getElementById('b').textContent, 'Close');
  w.ObsidianI18n.setLanguage('ru');
  assert.equal(w.document.getElementById('b').textContent, 'Закрыть');
  w.document.getElementById('b').click(); assert.equal(clicks, 1);
});
test('English translates dynamic price alerts without changing the numeric value', t => {
  const w = build(t, '<div></div>'); w.ObsidianI18n.setLanguage('en');
  assert.equal(w.ObsidianI18n.t('BINANCE · ETHUSDT достиг уровня $2,710.58'), 'BINANCE · ETHUSDT reached $2,710.58');
  assert.equal(w.ObsidianI18n.t('BN · ETHUSDT: 2710.58 USDT'), 'BN · ETHUSDT: 2710.58 USDT');
});

test('every English navigation tab remains selected when its view opens', t => {
  const w = build(t); w.ObsidianI18n.setLanguage('en');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const start = source.indexOf('  // Highlight active navbar tab');
  const end = source.indexOf('\n  if (view === "screener")', start);
  for (const view of ['screener', 'map', 'arbitrage', 'formations', 'backtest', 'journal', 'events']) {
    w.eval(`const view = '${view}';\n` + source.slice(start, end));
    const selected = [...w.document.querySelectorAll('#nav .ntab[aria-selected="true"]')];
    assert.equal(selected.length, 1, `selected tab missing for ${view}`);
    assert.equal(selected[0].getAttribute('onclick'), `switchView('${view}')`);
  }
});
