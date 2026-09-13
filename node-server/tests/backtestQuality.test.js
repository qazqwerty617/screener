const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/js/backtest.js'), 'utf8');
function scoreFunction() {
  const a = server.indexOf('function scoreBacktestCandidate('), b = server.indexOf('function findBestBacktestWindow(', a);
  return new Function(server.slice(a,b) + '; return scoreBacktestCandidate;')();
}
test('a single long wick cannot make an otherwise flat recent chart qualify', () => {
  const candles = Array.from({length:290}, (_,i) => {
    const c = i < 175 || i >= 200 ? 100 + Math.sin(i / 5) * 6 : 100;
    return {t:i*300000, o:c, c, h:c+0.01, l:c-0.01, v:1000};
  });
  candles[190].h = 109;
  assert.equal(scoreFunction()(candles, 200, 200, 90, '5m'), 0);
});
test('an old replay response must not leak candles into the next case', async () => {
  const start = app.indexOf('  async function fetchStepBuffer('), end = app.indexOf('  async function newCase()',start);
  const state = {session:{id:'old'}, requestSeq:1, stepBuffer:[], fetchingBuffer:false};
  let finish;
  const fetch = () => new Promise(resolve => { finish = () => resolve({ok:true,json:async()=>({candles:[[1,1,2,1,2,10]],done:true})}); });
  const run = new Function('state','fetch', 'parseCandle', app.slice(start,end)+'; return fetchStepBuffer;')(state,fetch,row=>row);
  const pending = run(); state.session = {id:'new'}; state.requestSeq = 2; finish(); await pending;
  assert.equal(state.stepBuffer.length, 0);
});

test('preparing the same market reuses one request and never downloads replay steps', async () => {
  const a=app.indexOf('  const preparedCases = new Map();'), b=app.indexOf('  async function fetchStepBuffer(',a);
  const urls=[];
  const fetch=async url=>{urls.push(url);return {ok:true,json:async()=>({id:'prepared',candles:[[1,1,2,1,2,3]]})};};
  const prepare=new Function('state','fetch',app.slice(a,b)+';return prepareCase;')({exchange:'BB',tf:'5m'},fetch);
  const [first,second]=await Promise.all([prepare(),prepare()]);
  assert.equal(first,second); assert.equal(urls.length,1); assert.match(urls[0],/\/new\?tf=5m&ex=BB/);
  await prepare('BN','15m'); assert.equal(urls.length,2);
});

test('quality ranking is independent of hidden future prices',()=>{
  const candles=Array.from({length:290},(_,i)=>({t:i,o:100+(i%2),c:100+((i+1)%2),h:102,l:99,v:10}));
  const score=scoreFunction()(candles,200,200,90,'5m');
  assert.ok(score>0);
  for(let i=200;i<candles.length;i++) candles[i]={...candles[i],o:1,c:1,h:1,l:1};
  assert.equal(scoreFunction()(candles,200,200,90,'5m'),score);
});
