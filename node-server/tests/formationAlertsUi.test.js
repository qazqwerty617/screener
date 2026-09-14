"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function build(t) {
  const dom = new JSDOM('<div id="auth-modal" style="display:none"></div><p id="formation-alert-sync-status"></p>', { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, sent = [];
  w.localStorage.setItem('obsidian_auth_token', 'test-session');
  Object.assign(w, { $: id => w.document.getElementById(id), AbortSignal, setInterval() {},
    coins: new Map([['BN:BTCUSDT', { v: 1e6 }]]), triggerMatchedFormationAlert: data => sent.push(data),
    isFormationCoinBlacklisted: () => false, isClientCoinInPlay: () => true,
    fetch: async () => ({ ok: true, json: async () => ({ success: true }) }) });
  const begin = source.indexOf('  window.handleServerFormationAlert =');
  const end = source.indexOf('  function isFormationCoinBlacklisted', begin);
  w.eval(source.slice(source.indexOf('const DEFAULT_FORMATION_ALERT_SETTINGS ='), source.indexOf('function initNotificationsUI()')) +
    '\nconst formationAlertCooldownMap = new Map();\n' + source.slice(begin,end) +
    `currentFormationAlertSettings = {...DEFAULT_FORMATION_ALERT_SETTINGS, enabled: true, toastEnabled: true};
    window.settings = currentFormationAlertSettings;`);
  return { w, sent };
}
const signal = { ex: 'BN', sym: 'BTCUSDT', tf: '15m', type: 'level', direction: 'short', targetPrice: 100.3, curPrice: 100, touches: 3, distPct: 0.3 };
test('a hidden auth modal allows a matching WebSocket alert and duplicates obey cooldown', t => {
  const { w, sent } = build(t);
  w.handleServerFormationAlert(signal); w.handleServerFormationAlert(signal);
  w.handleServerFormationAlert({ ...signal, ex: 'BB', tf: '1h' });
  assert.equal(sent.length, 1);
});
test('volume, global disable and visible auth modal suppress notifications', t => {
  const { w, sent } = build(t);
  w.settings.minVolume = 2e6; w.handleServerFormationAlert(signal);
  w.settings.minVolume = 0; w.settings.enabled = false; w.handleServerFormationAlert(signal);
  w.settings.enabled = true; w.$('auth-modal').style.display = 'flex'; w.handleServerFormationAlert(signal);
  assert.equal(sent.length, 0);
});
test('retest stage and age filters apply to pushed alerts', t => {
  const { w, sent } = build(t);
  const retest = { ...signal, type: 'retest', direction: 'long', meta: { status: 'approaching', lastTouchAge: 0 } };
  w.handleServerFormationAlert(retest);
  w.handleServerFormationAlert({ ...retest, meta: { status: 'confirmed', lastTouchAge: 100 } });
  assert.equal(sent.length, 0);
  w.settings.retest = { ...w.settings.retest, stage: 'approaching' };
  w.handleServerFormationAlert(retest);
  assert.equal(sent.length, 1);
});
test('failed settings sync remains pending and retry requires server acknowledgement', async t => {
  const { w } = build(t);
  w.fetch = async () => ({ ok: false });
  assert.equal(await w.saveFormationAlertSettings(w.settings), false);
  assert.ok(w.localStorage.getItem('formation_alert_sync_pending'));
  w.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
  assert.equal(await w.saveFormationAlertSettings(w.settings), true);
  assert.equal(w.localStorage.getItem('formation_alert_sync_pending'), null);
});
test('concurrent settings saves reach server in order', async t => {
  const { w } = build(t), received = [];
  let release;
  w.fetch = async (url, options) => {
    received.push(JSON.parse(options.body).minVolume);
    if (received.length === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ success: true }) };
  };
  const first = w.syncFormationAlertSettingsToServer({ minVolume: 100 });
  const second = w.syncFormationAlertSettingsToServer({ minVolume: 200 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [100]); release();
  await Promise.all([first, second]);
  assert.deepEqual(received, [100, 200]);
});
