'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {confirmationTiming} = require('../transferNetworkTiming');
const {transferPaths} = require('../spotArbitrage');

test('network time uses the destination deposit confirmation count and its canonical chain', () => {
  const catalogs = new Map([
    ['BN', new Map([['ETH', [{network:'ETHOP',withdraw:true,fee:.00008,confirmations:99}] ]])],
    ['BG', new Map([['ETH', [{network:'op-mainnet',deposit:true,confirmations:8}] ]])]
  ]);
  const path = transferPaths(catalogs, 'ETH', 'BN', 'BG').paths[0];
  assert.equal(path.identity, 'native');
  assert.equal(path.confirmationEstimateMs, 16000);
  assert.equal(path.confirmationTiming.basis, 'deposit_confirmations_model');
});

test('timing remains unknown without a supported chain or a valid provider confirmation count', () => {
  for (const count of [null, undefined, NaN, Infinity, -1, '8']) assert.equal(confirmationTiming('OP', count), null);
  assert.equal(confirmationTiming('UNKNOWN', 8), null);
  assert.equal(confirmationTiming('OP', 0).ms, 2000, 'zero confirmations never means instant transfer');
});

test('confirmation models preserve fractional block times and expose primary source links', () => {
  for (const [network,seconds] of Object.entries({BTC:600,ETH:12,ARB:.25,OP:2,BASE:2,BSC:.45,TRX:3,LTC:150,DOGE:60,ADA:20,OPBNB:.25,POLYGON:1})) {
    const estimate=confirmationTiming(network, 4);
    assert.equal(estimate.ms, seconds * 4000);
    assert.match(estimate.source, /^https:\/\//);
    assert.equal(estimate.reviewedAt, '2026-10-02');
  }
});
