'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),{calculateSpotFlow}=require('../spotArbitrage');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const scripts=['spot-arbitrage.js','arbitrage.js'].map(file=>fs.readFileSync(path.join(__dirname,'../public/js',file),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function row(unknown=false){
  const now=Date.now(),p=unknown?null:{network:'BTC',identity:'native',fee:.00002,depositFee:0};
  return {key:'spot:BTC:BN:BG',base:'BTC',buyEx:'BN',sellEx:'BG',buyName:'Binance',sellName:'Bitget',buyAsk:60000,sellBid:61000,
    buyUrl:'https://www.binance.com/en/trade/BTC_USDT?type=spot',sellUrl:'https://www.bitget.com/spot/BTCUSDT',buyAt:now,sellAt:now,
    generatedAt:now,spreadSince:now-120000,spreadSamples:25,spreadAgeMs:120000,ageMs:0,liquidity:1e6,gross:1.6667,
    path:p,transferStatus:p?'open':'unknown',estimate:'bbo',flow:calculateSpotFlow({asks:[[60000,100]],bids:[[61000,100]],notional:500,buyFeePct:.1,sellFeePct:.2,path:p})};
}
function setup(t,{unknown=false,pendingQuote=false}={}){
  const dom=new JSDOM(html,{url:'https://obsidianscreener.com',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,requests=[],r=row(unknown);let release;
  w.console.warn=()=>{};w.fetch=async(url,options)=>{
    requests.push({url,options});
    if(url.includes('/spot/quote?')){
      const response={ok:true,json:async()=>({...r,estimate:'depth',generatedAt:Date.now()})};
      if(pendingQuote)return new Promise(resolve=>release=()=>resolve(response));return response;
    }
    if(url.includes('/spot?'))return {ok:true,json:async()=>({generatedAt:Date.now(),rows:[r],total:1,notional:500,exchangeCount:2,marketCount:1,sources:{BN:{name:'Binance',status:'ok'},BG:{name:'Bitget',status:'ok'}}})};
    return {ok:true,json:async()=>({generatedAt:Date.now(),spreads:[],funding:[],totals:{spreads:0,funding:0}})};
  };
  scripts.forEach(script=>w.eval(script));
  t.after(()=>{w.CryptoArbitrage.deactivate();w.close();});
  w.CryptoArbitrage.activate();
  return {w,requests,r,release:()=>release?.()};
}
async function activateSpot(w){w.document.querySelector('[data-arb-mode="spot"]').click();await tick();await tick();}
test('spot mode offers all eleven original plus four new venues and sends those selections',async t=>{
  const {w,requests}=setup(t);await activateSpot(w);const d=w.document;
  assert.equal(d.getElementById('arb-spot-table').hidden,false);assert.equal(d.getElementById('arb-spreads-table').hidden,true);
  assert.equal([...d.querySelectorAll('.arb-exchange')].filter(b=>!b.hidden).length,15);
  const sent=new URL(requests.find(r=>r.url.includes('/spot?')).url,'https://obsidianscreener.com').searchParams.get('exchanges').split(',');
  for(const ex of ['BX','HL','AD','PL','CD','KR','BS'])assert.ok(sent.includes(ex));
  assert.match(d.getElementById('arb-net-label').textContent,/Оценка после перевода/);
  assert.ok(requests.some(r=>r.url.includes('/spot?')&&r.url.includes('notional=500')));
  d.getElementById('arb-spot-buy-fee').value='0';assert.equal(w.ArbitrageSpot.parameters().buyFeePct,'0');
  assert.equal(d.querySelector('#arb-spot-body tr').children.length,11);
});
test('coverage denominator follows the registry and source failures explain their actual status',async t=>{
  const {w,r}=setup(t);await activateSpot(w);
  const venues=Object.fromEntries(['BN','BB','OX','BG','GT','MX','KC','BX','HT','HL','AD','PL','CD','KR','BS'].map(ex=>[ex,{}]));
  w.ArbitrageSpot.render({rows:[r],venues,sources:{BX:{name:'BingX',status:'rate_limited'},HL:{name:'Hyperliquid',status:'fx_unavailable'}},notional:500,total:1,exchangeCount:13,marketCount:2500});
  assert.match(w.document.getElementById('arb-shown').textContent,/13\/15/);
  const text=w.document.getElementById('arb-spot-source-health').textContent;assert.match(text,/BingX \(лимит API\)/);assert.match(text,/нет свежего курса USDC\/USDT/);
});
for(const language of ['ru','en'])test(`USDC comparison shows native price, FX source and unverified bridge in ${language}`,async t=>{
  const {w,r}=setup(t,{unknown:true});w.ObsidianI18n={language};await activateSpot(w);
  Object.assign(r,{key:'spot:HYPE:BN:HL',base:'HYPE',buyQuote:'USDT',sellQuote:'USDC',sellName:'Hyperliquid',sellEx:'HL',sellNativeBid:91,
    conversions:{buy:null,sell:{ex:'BN',bid:1.0001,ask:1.0002,feePct:.1}}});
  r.flow.reasons.push('quote_conversion_unverified','bridge_unverified');
  w.ArbitrageSpot.render({rows:[r],sources:{},notional:500,marketCount:1});
  const d=w.document;assert.match(d.querySelector('#arb-spot-body').textContent,/HYPEUSDC/);
  assert.doesNotMatch(d.querySelector('#arb-spot-body').textContent,/HYPE\/USDT/);
  d.querySelector('#arb-spot-body tr').click();await tick();const body=d.querySelector('.spot-dialog-body');
  assert.match(body.textContent,/HYPE · USDT → USDC/);assert.match(body.textContent,/SELL bid 91 USDC/);assert.match(body.textContent,/BN USDC\/USDT/);
  assert.match(body.textContent,language==='en'?/bridge.*unconfirmed/:/Мост.*не подтверждены/);
  assert.equal(body.querySelector('.spot-result.confirmed'),null);
});
test('pointer hover and keyboard focus never open a route or fetch books; click opens the ledger',async t=>{
  const {w,requests}=setup(t);await activateSpot(w);const d=w.document,r=d.querySelector('#arb-spot-body tr');
  assert.equal(requests.filter(r=>r.url.includes('/spot/quote')).length,0);
  r.dispatchEvent(new w.MouseEvent('pointerover',{bubbles:true}));await sleep(180);await tick();
  r.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));await sleep(10);
  assert.equal(requests.filter(r=>r.url.includes('/spot/quote')).length,0);
  assert.equal(d.getElementById('arb-spot-popover').hidden,true);
  assert.equal(d.getElementById('arb-spot-dialog').hasAttribute('open'),false);
  r.click();await tick();
  assert.equal(requests.filter(r=>r.url.includes('/spot/quote')).length,1);
  const pop=d.querySelector('.spot-dialog-body');assert.equal(d.getElementById('arb-spot-popover').hidden,true);
  assert.match(pop.textContent,/Покупка · Binance/);assert.match(pop.textContent,/Перевод · BTC/);assert.match(pop.textContent,/Продажа · Bitget/);
  assert.match(pop.textContent,/2м/);assert.match(pop.textContent,/Комиссия вывода/);
});
test('unknown transfer fee remains unknown in table and detail; sale quantity is never invented',async t=>{
  const {w}=setup(t,{unknown:true});await activateSpot(w);const d=w.document;
  d.querySelector('#arb-spot-body tr').click();await tick();
  assert.equal(d.getElementById('arb-spot-dialog').hasAttribute('open'),true);
  assert.match(d.querySelector('.spot-dialog-body').textContent,/Нет подтверждённой сети перевода/);
  assert.match(d.querySelector('.spot-dialog-body').textContent,/Комиссия вывода— BTC/);
  assert.match(d.querySelector('.spot-dialog-body').textContent,/Количество— BTC/);
  assert.doesNotMatch(d.querySelector('.spot-dialog-body').textContent,/Расчёт по свежим стаканам/);
});
test('leaving spot ignores a pending quote and restores futures controls and venue choices',async t=>{
  const {w,release,requests}=setup(t,{pendingQuote:true});await activateSpot(w);const d=w.document;
  d.querySelector('#arb-spot-body tr').click();await tick();
  d.querySelector('[data-arb-mode="spreads"]').click();release();await tick();await tick();
  assert.equal(d.getElementById('arb-spot-dialog').hasAttribute('open'),false);assert.equal(d.getElementById('arb-spot-controls').hidden,true);
  assert.equal([...d.querySelectorAll('.arb-exchange')].filter(b=>!b.hidden).length,11);
  assert.match(d.getElementById('arb-net-label').textContent,/Лучший net при схождении/);
  assert.equal(requests.find(r=>r.url.includes('/spot/quote')).options.signal.aborted,true);
});
test('late quote after changing budget cannot paint the old profitable ledger',async t=>{
  const {w,release}=setup(t,{pendingQuote:true});await activateSpot(w);const d=w.document;
  d.querySelector('#arb-spot-body tr').click();await tick();
  const input=d.getElementById('arb-spot-notional');input.value='1000';input.dispatchEvent(new w.Event('input',{bubbles:true}));
  release();await tick();assert.doesNotMatch(d.querySelector('.spot-dialog-body').textContent,/Расчёт по свежим стаканам/);
});
test('invalid budget and fee reject calculations locally; zero fee remains valid',async t=>{
  const {w,requests}=setup(t);await activateSpot(w);const d=w.document;
  d.getElementById('arb-spot-notional').value='0';assert.equal(w.ArbitrageSpot.parameters(),null);
  const count=requests.length;w.CryptoArbitrage.refresh();await tick();assert.equal(requests.length,count);
  assert.equal(d.querySelectorAll('#arb-spot-body tr').length,0);assert.match(d.getElementById('arb-spot-source-health').textContent,/Проверьте бюджет/);
  d.getElementById('arb-spot-notional').value='555.5';d.getElementById('arb-spot-buy-fee').value='0';assert.equal(w.ArbitrageSpot.parameters().notional,'555.5');
  d.getElementById('arb-spot-buy-fee').value='-1';assert.equal(w.ArbitrageSpot.parameters(),null);
});
test('source disconnection does not preserve old opportunities after quote expiry',async t=>{
  const {w,r}=setup(t);await activateSpot(w);r.buyAt=Date.now()-20000;r.sellAt=r.buyAt;
  w.ArbitrageSpot.render({rows:[r],total:1,notional:500,sources:{},marketCount:1});
  assert.equal(w.document.querySelectorAll('#arb-spot-body tr').length,0);
});
test('English detail uses English ledger labels and conditional assumptions',async t=>{
  const {w}=setup(t);w.ObsidianI18n={language:'en'};await activateSpot(w);
  assert.equal(w.document.getElementById('arb-update-age').textContent,'updated just now');
  w.document.querySelector('#arb-spot-body tr').click();await tick();const content=w.document.querySelector('.spot-dialog-body').textContent;
  assert.match(content,/Buy · Binance/);assert.match(content,/Withdrawal fee/);assert.match(content,/Spot|Trading fees are modelled/);
  assert.doesNotMatch(content,/Покупка|Комиссия|Спред живёт/);
});

test('cheaper and faster network cards select a route and a late previous response cannot undo that choice',async t=>{
  const {w,r}=setup(t);await activateSpot(w);const pending=[],d=w.document;
  r.paths=[{...r.path,network:'BTC'},{...r.path,network:'OP',fee:.00003}];
  r.flow.withdrawFeeUsdt=1.2;
  r.recommendations={cheapest:{network:'BTC',totalFee:.00002,feeUsdt:1.2},fastest:{network:'OP',confirmationEstimateMs:40000},
    pathCount:2,eligibleCount:2,timedCount:2};
  w.ArbitrageSpot.render({rows:[r],sources:{},notional:500,marketCount:1});
  w.fetch=async(url,options)=>new Promise(resolve=>pending.push({url,options,resolve}));
  d.querySelector('#arb-spot-body tr').click();await tick();
  assert.equal(pending.length,1);
  d.querySelector('[data-spot-select-network="OP"]').click();await tick();
  assert.equal(pending.length,2);assert.equal(pending[0].options.signal.aborted,true);assert.match(pending[1].url,/network=OP/);
  assert.match(d.querySelector('.spot-dialog-body').textContent,/Комиссия вывода— BTC(?! ≈)/,
    'a pending network change must not reuse the previous network fee in USDT');
  const result={...r,path:r.paths[1],estimate:'depth',generatedAt:Date.now()};
  pending[1].resolve({ok:true,json:async()=>result});await tick();
  pending[0].resolve({ok:true,json:async()=>({...r,estimate:'depth',generatedAt:Date.now()})});await tick();
  assert.equal(d.querySelector('[data-spot-network]').value,'OP');
  assert.match(d.querySelector('.spot-dialog-body').textContent,/Быстрее по подтверждениям/);
  assert.match(d.querySelector('.spot-dialog-body').textContent,/обработка биржей не учтены/);
});

test('favorite button never opens the calculation; keyboard Enter opens it',async t=>{
  const {w,requests}=setup(t);await activateSpot(w);const d=w.document,r=d.querySelector('#arb-spot-body tr');
  r.querySelector('[data-fav]').click();await tick();
  assert.equal(d.getElementById('arb-spot-dialog').hasAttribute('open'),false);
  assert.equal(requests.filter(r=>r.url.includes('/spot/quote')).length,0);
  r.dispatchEvent(new w.KeyboardEvent('keydown',{bubbles:true,key:'Enter'}));await tick();
  assert.equal(d.getElementById('arb-spot-dialog').hasAttribute('open'),true);
});
