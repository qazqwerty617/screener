'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const engineSource=fs.readFileSync(path.join(__dirname,'../alertEngine.js'),'utf8');
function subscriberContext(user,admin='42'){
  const start=engineSource.indexOf('let cachedSubscribers = null;'),end=engineSource.indexOf('// ──',start+20);
  const code=engineSource.slice(start,end);
  const ctx={Date,Map,Set,process:{env:{ADMIN_CHAT_ID:admin}},userStoreModule:{getAllUsersRaw:()=>[user]},
    DEFAULT_USER_ALERT_SETTINGS:{pumpDump:{}},normalizeExchanges:v=>v,require:()=>({readFileSync:()=>'{"alertMinPct":5}',join:()=>''}),__dirname:''};
  vm.runInNewContext(code+';this.list=getAllAlertSubscribers',ctx);
  return ctx;
}
function subscribers(user,admin='42'){return subscriberContext(user,admin).list();}

test('a preferences revision invalidates the subscriber cache immediately after disabling pumps',()=>{
  const user={id:'owner',telegramChatId:'42',preferences:{notifications:{pumpDump:{enabled:true,tgEnabled:true}}}};
  const ctx=subscriberContext(user);let revision=0;ctx.userStoreModule.getPreferencesRevision=()=>revision;
  assert.equal(ctx.list()[0].pumpDump.enabled,true);
  user.preferences.notifications.pumpDump.enabled=false;revision++;
  assert.equal(ctx.list()[0].pumpDump.enabled,false);
});
for(const setting of [{tgEnabled:false,enabled:true},{tgEnabled:true,enabled:false}])test('disabled pump setting is honoured for the admin, including fallback '+JSON.stringify(setting),()=>{
  const result=subscribers({id:'owner',telegramChatId:'42',preferences:{notifications:{pumpDump:setting}}});
  assert.equal(result.some(s=>s.pumpDump.enabled),false);
});
test('blocked admin never returns through the fallback subscription',()=>{
  assert.equal(subscribers({id:'owner',telegramChatId:'42',blocked:true,preferences:{}}).length,0);
});
test('disabling pumps does not disable independently configured price alerts',()=>{
  const result=subscribers({id:'owner',telegramChatId:'42',priceAlerts:[{targetPrice:100}],
    preferences:{notifications:{pumpDump:{enabled:false,tgEnabled:false}}}});
  assert.equal(result.length,1);assert.equal(result[0].pumpDump.enabled,false);assert.equal(result[0].priceAlerts.length,1);
});

const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function dispatcher(settings, user = {id:'u',telegramChatId:'42',preferences:{formationAlerts:settings}}){
  const start=source.indexOf('  function checkAndDispatchServerFormationAlerts(');
  const end=source.indexOf('  // 24/7 Server-Side Offline Alert Engine',start);
  assert.ok(start>0&&end>start);
  const sent=[],broadcast=[],queued=[];
  const ctx={Date,Map,Set,Buffer,Promise,console:{warn(){}},process:{env:{}},
    userStore:{getAllUsersRaw:()=>[user],isTelegramAlertsEnabled:()=>true},
    telegramQueue:{enqueue:async opts=>{queued.push(opts);if(opts.shouldSend&&!opts.shouldSend())return {ok:false};sent.push(opts.text);return {ok:true};}},
    formationAlertsByChatId:new Map(),getFormationChatPrefs:()=>null,
    tickers:new Map([['BN:BTCUSDT',{p:100,v:1e6}]]),
    pruneFormationCooldowns(){},refreshInPlayMovers(){},inPlayMoversSet:new Set(),
    broadcastAlert:(type,payload)=>broadcast.push(payload),scoreFormationSignal:()=>1,
    serverFormationAlertCooldown:new Map(),serverFormationCoinCooldown:new Map(),serverFormationLastSentAt:new Map(),
    getFormationCoinCooldownMs:()=>300000,FORMATION_MIN_GAP_MS:45000,FORMATION_FAILED_RETRY_MS:60000,
    normalizeCoinKey:({base})=>base,saveFormationCooldowns(){},renderServerChartSnapshot:()=>Buffer.from('chart')};
  const helperStart=source.indexOf('  function isFormationTelegramDeliveryAllowed(');
  vm.runInNewContext(source.slice(helperStart,end)+';this.dispatch=checkAndDispatchServerFormationAlerts',ctx);
  return {ctx,sent,broadcast,queued};
}
test('real pattern scanner Range reaches Telegram dispatch even when legacy total touches are absent',async()=>{
  const {scanCandles}=require('../patternDetector');
  const candles=Array.from({length:40},(_,i)=>({t:Date.now()-(40-i)*900000,o:100,h:100.2,l:99.8,c:100,v:100}));
  const signals=scanCandles({ex:'BN',sym:'BTCUSDT',base:'BTC',tf:'15m'},candles,{},
    {ranges:[{lower:99.5,upper:102,lowerTouches:3,upperTouches:3,widthPct:2.48}],trendlines:[],horizontals:[],retests:[]});
  assert.equal(signals.filter(s=>s.type==='range').length,1);
  assert.equal(signals[0].confidence,3);
  const {ctx,sent}=dispatcher({enabled:true,tgEnabled:true,exchanges:['BN'],range:{enabled:true,timeframes:['15m'],minTouches:3,distancePct:.6},
    trendline:{enabled:false},level:{enabled:false},retest:{enabled:false}});
  ctx.dispatch(signals,100,{'15m':candles});await new Promise(r=>setImmediate(r));
  assert.equal(sent.length,1);assert.match(sent[0],/Range.*Боковик/);
});

test('formation queue checks the CURRENT Range preference, venue and timeframe at send time',async()=>{
  const settings={enabled:true,tgEnabled:true,exchanges:['BN'],range:{enabled:true,timeframes:['15m'],minTouches:2,distancePct:1}};
  const {ctx,queued}=dispatcher(settings);
  ctx.dispatch([{ex:'BN',sym:'BTCUSDT',base:'BTC',tf:'15m',type:'range',price:99.5,
    meta:{lower:99.5,upper:102,lowerTouches:3,upperTouches:3,widthPct:2.48}}],100,{});
  await new Promise(r=>setImmediate(r));assert.equal(queued.length,1);
  assert.equal(queued[0].shouldSend(),true);
  settings.range.enabled=false;assert.equal(queued[0].shouldSend(),false);
  settings.range.enabled=true;settings.exchanges=['BB'];assert.equal(queued[0].shouldSend(),false);
  settings.exchanges=['BN'];settings.range.timeframes=['4h'];assert.equal(queued[0].shouldSend(),false);
  settings.range.timeframes=['15m'];settings.tgEnabled=false;assert.equal(queued[0].shouldSend(),false);
});

test('queued Range respects a raised touch threshold and cancels after a live breakout',async()=>{
  const settings={enabled:true,tgEnabled:true,exchanges:['BN'],range:{enabled:true,timeframes:['15m'],minTouches:2,distancePct:1}};
  const {ctx,queued}=dispatcher(settings);
  ctx.dispatch([{ex:'BN',sym:'BTCUSDT',base:'BTC',tf:'15m',type:'range',price:99.5,
    meta:{lower:99.5,upper:102,lowerTouches:3,upperTouches:3,widthPct:2.48}}],100,{});
  await new Promise(r=>setImmediate(r));assert.equal(queued.length,1);
  settings.range.minTouches=4;assert.equal(queued[0].shouldSend(),false);
  settings.range.minTouches=2;assert.equal(queued[0].shouldSend(),true);
  ctx.tickers.set('BN:BTCUSDT',{p:103,v:1e6});assert.equal(queued[0].shouldSend(),false);
});

test('legacy formation destination stored in its preferences survives send-time revalidation',async()=>{
  const settings={enabled:true,tgEnabled:true,telegramChatId:'42',exchanges:['BN'],range:{enabled:true,timeframes:['15m'],minTouches:2,distancePct:1}};
  const {ctx,sent}=dispatcher(settings,{id:'u',preferences:{formationAlerts:settings}});
  ctx.dispatch([{ex:'BN',sym:'BTCUSDT',base:'BTC',tf:'15m',type:'range',price:99.5,
    meta:{lower:99.5,upper:102,lowerTouches:3,upperTouches:3,widthPct:2.48}}],100,{});
  await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);
});
