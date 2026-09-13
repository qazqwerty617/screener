const test = require('node:test');
const assert = require('node:assert/strict');
const {createBacktestPool} = require('../backtestPool');
const rows = Array.from({length: 300}, (_,t) => ({t}));
const selectWindow = candles => ({visible:candles.slice(0,200),future:candles.slice(200)});
test('returns a ready candidate while another exchange request is still pending', async () => {
  let release;
  const slow = new Promise(resolve => {release = resolve;});
  const pool = createBacktestPool({target:1,concurrency:2,timeoutMs:1000,
    getUniverse:()=>[{ex:'BB',sym:'slow'},{ex:'BB',sym:'fast'}],
    loadCandles: (_,sym)=>sym==='slow'?slow:Promise.resolve(rows), selectWindow});
  try { assert.equal((await pool.take('BB','5m')).ticker.sym,'fast'); }
  finally { release(rows); await pool.warm('BB','5m'); }
});
test('shares history requests across concurrent case requests and bounds concurrency', async () => {
  let calls=0,active=0,peak=0,cut=180;
  const pool=createBacktestPool({target:1,concurrency:2,
    getUniverse:()=>['A','B','C','D'].map(sym=>({ex:'BB',sym})),
    loadCandles:async()=>{calls++;peak=Math.max(peak,++active);await new Promise(r=>setImmediate(r));active--;return rows;},
    selectWindow:candles=>({visible:candles.slice(0,cut++),future:candles.slice(240)})});
  const results=await Promise.all([pool.take('BB','5m'),pool.take('BB','5m')]);
  await pool.warm('BB','5m');
  assert.equal(results.length,2); assert.ok(peak<=2); assert.ok(calls<=4);
  const before=calls; await pool.take('BB','5m'); await pool.warm('BB','5m'); assert.equal(calls,before);
});
test('rejects empty or inactive markets without falling back to a flat chart', async () => {
  const pool=createBacktestPool({getUniverse:()=>[{ex:'BB',sym:'flat'}],loadCandles:async()=>rows,selectWindow:()=>null});
  await assert.rejects(pool.take('BB','5m'),/Активный участок/);
});
