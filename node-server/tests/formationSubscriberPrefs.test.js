"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('    const allUsers = Object.values', source.indexOf('async function checkAndDispatchServerFormationAlerts'));
const end = source.indexOf('    if (subscribers.length === 0) return;', start);
assert.ok(start > 0 && end > start);
const collect = new Function('userStore', 'formationAlertsByChatId', 'getFormationChatPrefs', 'process', source.slice(start, end) + '\nreturn subscribers;');
function subscribers(users, overrides = new Map()) {
  return collect({ getAllUsersRaw: () => users }, overrides, id => overrides.get(id)?.settings, { env: { ADMIN_CHAT_ID: '42' } });
}
test('explicitly disabled admin Telegram alerts never fall back to all formations', () => {
  assert.equal(subscribers([{ id: 'u', telegramChatId: '42', preferences: { formationAlerts: { tgEnabled: false, enabled: false } } }]).length, 0);
});
test('a disabled standalone preference also suppresses the admin fallback', () => {
  assert.equal(subscribers([], new Map([['42', { settings: { enabled: false, tgEnabled: false } }]])).length, 0);
});
test('Binance trendline preferences survive subscriber construction without broadening', () => {
  const settings = { enabled: true, tgEnabled: true, exchanges: ['BN'], trendline: { enabled: true }, level: { enabled: false }, retest: { enabled: false } };
  const result = subscribers([{ id: 'u', telegramChatId: '42', preferences: { formationAlerts: settings } }]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].settings.exchanges, ['BN']);
  assert.equal(result[0].settings.level.enabled, false);
  assert.equal(result[0].settings.retest.enabled, false);
  assert.equal(result[0].settings.range.enabled, false);
});

test('actual Telegram range gate honours venue, timeframe, two boundaries and fresh price', () => {
  const begin = source.indexOf('        // Check exchange filter', start);
  const finish = source.indexOf('        // Per-coin gate', begin);
  const gate = new Function('signals', 's', `const out = []; for (const signal of signals) {
    const {ex,sym,base,tf,type,price,meta} = signal, touches=meta.touches, dist=meta.dist, fallbackCurPrice=signal.curPrice;
    ${source.slice(begin, finish)}
    out.push(ex + ':' + type + ':' + tf);
  } return out;`);
  const good = { ex: 'BN', sym: 'BTCUSDT', base: 'BTC', tf: '15m', type: 'range', price: 102, curPrice: 100,
    meta: { lower: 99.5, upper: 102, lowerTouches: 3, upperTouches: 3, touches: 3, dist: 2 } };
  const s = { exchanges: ['BN'], range: { enabled: true, timeframes: ['15m'], minTouches: 3, distancePct: 0.6 } };
  assert.deepEqual(gate([ { ...good, ex: 'BB' }, { ...good, tf: '4h' },
    { ...good, curPrice: 98 }, { ...good, curPrice: 101 },
    { ...good, meta: { ...good.meta, upperTouches: 2 } }, good ], s), ['BN:range:15m']);
  assert.deepEqual(gate([good], { ...s, range: { ...s.range, enabled: false } }), []);
});

test('the actual Telegram dispatch gate admits only selected types, venues and timeframes', () => {
  const begin = source.indexOf('        // Check exchange filter', start);
  const finish = source.indexOf('        // Per-coin gate', begin);
  const gate = new Function('signals', 's', `const out = []; for (const signal of signals) {
    const {ex,sym,base,tf,type,price,meta} = signal, touches=meta.touches, dist=meta.dist, fallbackCurPrice=100;
    ${source.slice(begin, finish)}
    out.push(ex + ':' + type + ':' + tf);
  } return out;`);
  const signals = ['BN','BB','OX'].flatMap(ex => ['trendline','level','retest'].flatMap(type => ['15m','4h'].map(tf => ({
    ex,sym:'BTCUSDT',base:'BTC',tf,type,price:100.3,direction:'short',meta:{touches:4,dist:0.3,status:'confirmed',lastTouchAge:1}
  }))));
  assert.deepEqual(gate(signals, {exchanges:['BN'],trendline:{enabled:true,timeframes:['15m'],minTouches:3,distancePct:0.5},level:{enabled:false},retest:{enabled:false}}), ['BN:trendline:15m']);
});
