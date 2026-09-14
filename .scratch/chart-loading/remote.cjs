"use strict";
// Read-only server inspection. Credentials are loaded without being printed.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('../../node-server/node_modules/ssh2');
const env = require('../../node-server/node_modules/dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../../.env')));
const mode = process.argv[2] || 'inspect';
const programs = {
  'grid-batch-3d': `(async()=>{const groups={MX:['SOPH_USDT','STONK_USDT','SPACEHOOD_USDT','VVV_USDT'],BB:['SOPHUSDT'],HL:['SOPH'],BX:['SOPH-USDT','STONK-USDT','USELESS-USDT'],BN:['SOPHUSDT','USELESSUSDT'],KC:['SOPHUSDTM','ESIMUSDTM','USELESSUSDTM'],BG:['SOPHUSDT'],GT:['SOPH_USDT','STONK_USDT','USELESS_USDT'],OX:['SOPH-USDT-SWAP','USELESS-USDT-SWAP','VVV-USDT-SWAP'],AD:['STONKUSDT','USELESSUSDT'],HT:['BTC-USDT']};
    for(const pass of [1,2])for(const [ex,symbols]of Object.entries(groups)){const start=Date.now(),r=await fetch('http://127.0.0.1:3000/api/klines/batch?'+new URLSearchParams({ex,symbols:symbols.join(','),tf:'3d',lite:'1',stream:'1'}),{signal:AbortSignal.timeout(15000)});const rows=(await r.text()).trim().split('\\n').filter(Boolean).map(JSON.parse);for(const sym of symbols){const d=rows.find(row=>row.sym===sym)?.data||[],flat=typeof d[0]==='number',count=d.length/(flat?6:1),step=count>1?(flat?d[6]-d[0]:d[1].t-d[0].t):null;console.log(JSON.stringify({pass,ex,sym,status:r.status,count,step,ms:Date.now()-start}));if(!count||(step&&step%259200000!==0))process.exitCode=1;}}})().catch(e=>{console.error(e.message);process.exitCode=1;});`,
  'grid-3d': `const pairs=[['MX','SOPH_USDT'],['KC','SOPHUSDTM'],['KC','ESIMUSDTM'],['MX','STONK_USDT'],['AD','STONKUSDT'],['GT','STONK_USDT'],['MX','SPACEHOOD_USDT'],['MX','VVV_USDT'],['KC','USELESSUSDTM'],['GT','USELESS_USDT'],['BB','SOPHUSDT']];
    (async()=>{for(const tf of ['3d','1d'])for(let i=0;i<pairs.length;i+=3)await Promise.all(pairs.slice(i,i+3).map(async([ex,sym])=>{const start=Date.now();try{const r=await fetch('http://127.0.0.1:3000/api/klines?'+new URLSearchParams({ex,sym,tf,lite:'1'}),{signal:AbortSignal.timeout(12000)});const d=await r.json(),bars=Array.isArray(d)?(typeof d[0]==='number'?Array.from({length:d.length/6},(_,i)=>({t:d[i*6]})):d):[];console.log(JSON.stringify({ex,sym,tf,status:r.status,count:bars.length,step:bars.length>1?bars[1].t-bars[0].t:null,ms:Date.now()-start,pending:r.headers.get('x-klines-pending')}));if(!bars.length||(tf==='3d'&&bars.length>1&&bars[1].t-bars[0].t!==259200000))process.exitCode=1;}catch(e){console.log(JSON.stringify({ex,sym,tf,error:e.message}));process.exitCode=1;}}));})()`,
  'history-pages': `(async()=>{for(const [ex,sym]of [['BN','BTCUSDT'],['BN','CROSSUSDT'],['HT','BTC-USDT']]){let cursor=null;for(let page=0;page<3;page++){
    const query=new URLSearchParams({ex,sym,tf:'1m',lite:'1'});if(cursor)query.set('before',String(cursor-1));const start=Date.now();
    const response=await fetch('http://127.0.0.1:3000/api/klines?'+query,{signal:AbortSignal.timeout(12000)});const data=await response.json();
    const bars=Array.isArray(data)?(typeof data[0]==='number'?Array.from({length:data.length/6},(_,i)=>({t:data[i*6]})):data):[];
    const older=bars.filter(c=>!cursor||c.t<cursor);console.log(JSON.stringify({ex,sym,page,status:response.status,count:older.length,ms:Date.now()-start,oldest:older[0]?.t,newest:older.at(-1)?.t}));
    if(!response.ok||!older.length){process.exitCode=1;break;}cursor=Math.min(...older.map(c=>c.t));
  }}})().catch(e=>{console.error(e.message);process.exitCode=1;});`,
  responsiveness: `(async()=>{const samples={health:[],history:[]};for(let i=0;i<12;i++){for(const [name,path]of [['health','/api/health'],['history','/api/klines?ex=BN&sym=BTCUSDT&tf=5m&lite=1']]){const start=Date.now();try{const r=await fetch('http://127.0.0.1:3000'+path,{signal:AbortSignal.timeout(15000)});await r.arrayBuffer();samples[name].push(Date.now()-start);}catch(e){samples[name].push(15000);}}await new Promise(r=>setTimeout(r,200));}for(const [name,values]of Object.entries(samples)){const sorted=[...values].sort((a,b)=>a-b);console.log(JSON.stringify({name,samples:values,p50:sorted[6],p95:sorted[11]}));}})().catch(e=>{console.error(e.message);process.exitCode=1;});`,
  profile: `(async()=>{const fs=require('fs'),{WebSocket}=require('/root/nother/node-server/node_modules/ws');
    const pid=Number(fs.readFileSync('/root/.pm2/pids/server-0.pid','utf8').trim());const command=fs.readFileSync('/proc/'+pid+'/cmdline','utf8');
    if(!Number.isInteger(pid)||!command.includes('/root/nother/node-server/server.js'))throw new Error('Unexpected profiling target');
    let targets;try{targets=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(1000)})).json();}catch{}
    const startedInspector=!targets;
    if(startedInspector){process.kill(pid,'SIGUSR1');for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,500));try{targets=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(1000)})).json();break;}catch{}}}
    if(!targets?.[0]?.webSocketDebuggerUrl)throw new Error('Local profiling endpoint unavailable');
    const ws=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
    const pending=new Map();let seq=0;ws.on('message',raw=>{const m=JSON.parse(raw);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const call=(method,params={})=>new Promise((r,j)=>{const id=++seq;pending.set(id,m=>m.error?j(new Error(m.error.message)):r(m.result));ws.send(JSON.stringify({id,method,params}));});
    const identity=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});
    if(identity.result?.value!==pid){ws.close();throw new Error('Existing inspector belongs to another process');}
    await call('Profiler.enable');await call('Profiler.setSamplingInterval',{interval:2000});await call('Profiler.start');
    console.log(JSON.stringify({stage:'profiling',pid,startedInspector}));
    await new Promise(r=>setTimeout(r,20000));const {profile}=await call('Profiler.stop');await call('Profiler.disable');
    const total=(profile.samples||[]).length;console.log(JSON.stringify({stage:'profile',samples:total,frames:profile.nodes.filter(n=>n.hitCount).sort((a,b)=>b.hitCount-a.hitCount).slice(0,20).map(n=>({name:n.callFrame.functionName,file:n.callFrame.url.split('/').slice(-2).join('/'),line:n.callFrame.lineNumber+1,samples:n.hitCount,pct:Math.round(n.hitCount/total*1000)/10}))}));
    // Close only the inspector this diagnostic opened, after releasing the client.
    if(startedInspector)await call('Runtime.evaluate',{expression:"setTimeout(() => require('node:inspector').close(), 100)",returnByValue:true});
    ws.close();
  })().catch(e=>{console.error(e.message);process.exitCode=1;});`,
  'privacy-status': `const fs=require('fs');const base='/root/nother/node-server/';const records=JSON.parse(fs.readFileSync(base+'journal_credentials.json'));
    let total=0,quarantined=0,confirmed=0;for(const entries of Object.values(records.users||{}))for(const record of Object.values(entries)){total++;if(record.quarantined)quarantined++;if(record.ownershipVersion===2)confirmed++;}
    console.log(JSON.stringify({total,quarantined,confirmed}));
    (async()=>{for(const route of ['/api/journal/credentials','/api/journal/live?exchange=BN&symbol=BTCUSDT']){const r=await fetch('http://127.0.0.1:3000'+route,{signal:AbortSignal.timeout(12000)});console.log(JSON.stringify({route,status:r.status}));if(r.status!==401)process.exitCode=1;}})().catch(e=>{console.error(e.message);process.exitCode=1});`,
  privacy: `const fs=require('fs'),crypto=require('crypto');const base='/root/nother/node-server/';
    for(const f of ['server.js','public/js/app.js','public/js/tradeOverlay.js','public/js/journal.js','journalCredentialStore.js','public/index.html']) console.log(JSON.stringify({file:f,sha256:crypto.createHash('sha256').update(fs.readFileSync(base+f)).digest('hex')}));
    const env=require(base+'node_modules/dotenv').parse(fs.readFileSync(base+'.env'));const {createJournalCredentialStore}=require(base+'journalCredentialStore');
    const store=createJournalCredentialStore({secret:env.JOURNAL_KEYS_ENCRYPTION_KEY||env.ADMIN_API_SECRET});
    const records=JSON.parse(fs.readFileSync(base+'journal_credentials.json'));const groups=new Map();let total=0;
    const salt=crypto.randomBytes(32);
    for(const [id,exchanges]of Object.entries(records.users||{}))for(const ex of Object.keys(exchanges)) {
      const c=store.get(id,ex);if(!c)continue;total++;const k=crypto.createHmac('sha256',salt).update(ex+'|'+c.apiKey).digest('hex');groups.set(k,(groups.get(k)||0)+1);
    }
    console.log(JSON.stringify({credentialRecords:total,duplicateCredentialGroups:[...groups.values()].filter(n=>n>1).length,affectedRecords:[...groups.values()].filter(n=>n>1).reduce((a,b)=>a+b,0)}));`,
  load: `const os=require('os'),cp=require('child_process');console.log(JSON.stringify({load:os.loadavg(),cores:os.cpus().length,freeMemory:os.freemem()})); console.log(cp.execSync('ps -eo pid,comm,pcpu,pmem,etime --sort=-pcpu | head -12',{encoding:'utf8'}));`,
  kucoin: `(async()=>{const {WebSocket}=require('/root/nother/node-server/node_modules/ws');const start=Date.now();
    const r=await fetch('https://api-futures.kucoin.com/api/v1/bullet-public',{method:'POST',signal:AbortSignal.timeout(6000)});const d=await r.json();
    console.log(JSON.stringify({stage:'token',ms:Date.now()-start,status:r.status,code:d.code,hasToken:!!d.data?.token}));if(!d.data?.token)return;
    const ws=new WebSocket(d.data.instanceServers[0].endpoint+'?token='+encodeURIComponent(d.data.token)+'&connectId='+Date.now(),{handshakeTimeout:6000});
    ws.on('open',()=>{console.log(JSON.stringify({stage:'open',ms:Date.now()-start}));ws.send(JSON.stringify({id:'candle',type:'subscribe',topic:'/contractMarket/limitCandle:XBTUSDTM_5min',privateChannel:false,response:true}));ws.send(JSON.stringify({id:'trade',type:'subscribe',topic:'/contractMarket/execution:XBTUSDTM',privateChannel:false,response:true}));});
    let messages=0;ws.on('message',raw=>{try{const m=JSON.parse(raw);if(messages++<5)console.log(JSON.stringify({stage:'message',ms:Date.now()-start,type:m.type,subject:m.subject,topic:m.topic,keys:Object.keys(m.data||{}),code:m.code}));}catch{}});
    ws.on('error',e=>console.log(JSON.stringify({stage:'error',ms:Date.now()-start,error:e.message.replace(/token=[^ &]+/g,'token=<REDACTED>')})));
    setTimeout(()=>ws.terminate(),18000);
  })().catch(e=>{console.log(e.message);process.exitCode=1})`,
  init: `const fs=require('fs'),crypto=require('crypto');
    for(const f of ['exchanges/okx.js','exchanges/bitget.js','exchanges/asterdex.js']) console.log(JSON.stringify({file:f,sha256:crypto.createHash('sha256').update(fs.readFileSync('/root/nother/node-server/'+f)).digest('hex')}));
    const files=fs.readdirSync('/root/.pm2/logs').filter(f=>f.startsWith('server'));console.log(JSON.stringify({logs:files}));
    (async()=>{for(const f of files){const lines=[];const rl=require('readline').createInterface({input:fs.createReadStream('/root/.pm2/logs/'+f),crlfDelay:Infinity});for await(const line of rl){if(/\\[(INIT|OX|BG|AD)\\]/.test(line)){lines.push(line.slice(0,250));if(lines.length>25)lines.shift();}}console.log(JSON.stringify({file:f,lines}));}})()`,
  diagnose: `const fs=require('fs');
    for(const file of ['/root/.pm2/logs/server-error.log','/root/.pm2/logs/server-out.log']) {
      if(!fs.existsSync(file))continue;const fd=fs.openSync(file,'r'),size=fs.fstatSync(fd).size,b=Buffer.alloc(Math.min(size,400000));fs.readSync(fd,b,0,b.length,size-b.length);fs.closeSync(fd);
      for(const line of b.toString().split('\\n').filter(x=>/\\[(OX|BG|AD|KC|MX|KL ERROR)\\]|VENUE PAUSED/.test(x)).slice(-25))console.log(line.replace(/token[=:][^ &]+/gi,'token=<REDACTED>').slice(0,300));
    }
    (async()=>{const d=await(await fetch('http://127.0.0.1:3000/api/tickers',{signal:AbortSignal.timeout(10000)})).json();const keys=d.filter(x=>typeof x==='string'&&x.includes(':'));for(const ex of ['OX','BG','AD','KC','MX'])console.log(JSON.stringify({ex,count:keys.filter(k=>k.startsWith(ex+':')).length,btc:keys.filter(k=>k.startsWith(ex+':')&&/BTC|XBT/.test(k)).slice(0,10)}));})()`,
  live: `const {WebSocket}=require('/root/nother/node-server/node_modules/ws');
    const pairs=[['BN','BTCUSDT'],['BB','BTCUSDT'],['OX','BTC-USDT-SWAP'],['BG','BTCUSDT'],['GT','BTC_USDT'],['MX','BTC_USDT'],['KC','XBTUSDTM'],['BX','BTC-USDT'],['HT','BTC-USDT'],['HL','BTC'],['AD','BTCUSDT']];
    const stats=Object.fromEntries(pairs.map(([ex])=>[ex,{events:0,klines:0,firstMs:null}]));
    const start=Date.now(),ws=new WebSocket('ws://127.0.0.1:3000/ws');
    ws.on('open',()=>{for(const [ex,sym] of pairs)ws.send(JSON.stringify({type:'subscribe_kline',ex,sym,tf:'5m'}));});
    ws.on('message',(raw,binary)=>{if(binary)return;try{const d=JSON.parse(raw);if(['kline','market_tick'].includes(d.type)&&stats[d.ex]){
      const s=stats[d.ex];s.events++;if(d.type==='kline')s.klines++;if(s.firstMs===null)s.firstMs=Date.now()-start;
    }if(d.type==='market_status'&&d.status==='rejected')console.log(JSON.stringify(d));}catch{}});
    ws.on('error',e=>console.error(e.message));
    setTimeout(()=>{for(const [ex,s]of Object.entries(stats)){console.log(JSON.stringify({ex,...s}));if(!s.events)process.exitCode=1;}ws.close();setTimeout(()=>ws.terminate(),1000).unref();},25000);`,
  inspect: `const fs=require('fs'),crypto=require('crypto');
    for(const f of ['server.js','public/js/app.js','public/index.html','public/css/app.css','exchanges/mexc.js']) {
      const b=fs.readFileSync('/root/nother/node-server/'+f);
      console.log(JSON.stringify({file:f,sha256:crypto.createHash('sha256').update(b).digest('hex')}));
    }
    (async()=>{for(const p of ['/api/health','/api/market-data/health']) {
      const r=await fetch('http://127.0.0.1:3000'+p,{signal:AbortSignal.timeout(10000)});
      const d=await r.json(); console.log(JSON.stringify({path:p,status:r.status,data:d}));
    }})().catch(e=>{console.error(e.message);process.exitCode=1});`,
  baseline: `const pairs=[['BN','BTCUSDT'],['BB','BTCUSDT'],['OX','BTC-USDT-SWAP'],['BG','BTCUSDT'],['GT','BTC_USDT'],['MX','BTC_USDT'],['KC','XBTUSDTM'],['BX','BTC-USDT'],['HT','BTC-USDT'],['HL','BTC'],['AD','BTCUSDT']];
    (async()=>{for(const pass of [1,2]) for(let i=0;i<pairs.length;i+=3) await Promise.all(pairs.slice(i,i+3).map(async([ex,sym])=>{
      const start=Date.now();try{
        const r=await fetch('http://127.0.0.1:3000/api/klines?'+new URLSearchParams({ex,sym,tf:'5m',lite:'1'}),{signal:AbortSignal.timeout(12000)});
        const data=await r.json(),flat=typeof data[0]==='number',count=Array.isArray(data)?data.length/(flat?6:1):0;
        const last=count?(flat?data.at(-6):data.at(-1).t):0;
        console.log(JSON.stringify({pass,ex,status:r.status,ms:Date.now()-start,count,pending:r.headers.get('x-klines-pending'),ageMs:last?Date.now()-last:null}));
        if(!count)process.exitCode=1;
      }catch(e){console.log(JSON.stringify({pass,ex,ms:Date.now()-start,error:e.message}));process.exitCode=1;}
    }));})()`,
};
programs.final = programs.inspect + '\n' + programs.live;
programs['grid-matrix'] = programs['grid-batch-3d']
  .replace("for(const pass of [1,2])for(const [ex,symbols]of Object.entries(groups))", "for(const tf of ['1m','5m','15m','1h','4h','1d','3d','1w'])for(const [ex,symbols]of Object.entries(groups))")
  .replace("tf:'3d'", "tf")
  .replace("{pass,ex,sym,status", "{tf,ex,sym,status")
  .replace("step%259200000", "step%({\"1m\":60000,\"5m\":300000,\"15m\":900000,\"1h\":3600000,\"4h\":14400000,\"1d\":86400000,\"3d\":259200000,\"1w\":604800000}[tf])");
programs['grid-matrix-summary'] = programs['grid-matrix']
  .replace('(async()=>{const groups=', '(async()=>{const measurements=[];const groups=')
  .replace('console.log(JSON.stringify({tf,ex,sym,status:r.status,count,step,ms:Date.now()-start}));', 'measurements.push({tf,ex,sym,status:r.status,count,step,ms:Date.now()-start});')
  .replace('}}})().catch', "}}for(const tf of [...new Set(measurements.map(m=>m.tf))]){const rows=measurements.filter(m=>m.tf===tf);console.log(JSON.stringify({tf,markets:rows.length,nonempty:rows.filter(m=>m.count>0).length,maxMs:Math.max(...rows.map(m=>m.ms)),empty:rows.filter(m=>!m.count)}));}console.log(JSON.stringify({total:measurements.length,exitCode:process.exitCode||0}));})().catch");
programs['live-3d'] = programs.live.replace("['BN','BTCUSDT'],['BB','BTCUSDT'],['OX','BTC-USDT-SWAP'],['BG','BTCUSDT'],['GT','BTC_USDT'],['MX','BTC_USDT'],['KC','XBTUSDTM'],['BX','BTC-USDT'],['HT','BTC-USDT'],['HL','BTC'],['AD','BTCUSDT']", "['BB','SOPHUSDT'],['MX','SOPH_USDT'],['KC','SOPHUSDTM'],['HT','BTC-USDT']")
  .replace("tf:'5m'", "tf:'3d'")
  .replace("const s=stats[d.ex];s.events++;", "const s=stats[d.ex];if(d.type==='kline'&&d.data[0]%259200000!==0){console.log(JSON.stringify({ex:d.ex,error:'Non-3d candle in live stream',t:d.data[0]}));process.exitCode=1;}s.events++;");
programs['synthetic-pages'] = programs['history-pages'].replace("[['BN','BTCUSDT'],['BN','CROSSUSDT'],['HT','BTC-USDT']]", "[['BB','SOPHUSDT'],['MX','SOPH_USDT'],['KC','SOPHUSDTM'],['HT','BTC-USDT']]").replace("tf:'1m'", "tf:'3d'");
programs['synthetic-pages-btc'] = programs['synthetic-pages'].replace("['BB','SOPHUSDT'],['MX','SOPH_USDT']", "['BB','BTCUSDT'],['MX','BTC_USDT']");
if (!programs[mode]) throw new Error('Unknown read-only mode');
const conn = new Client();
conn.on('ready', () => conn.exec('node -', (err, stream) => {
  if (err) throw err;
  stream.on('data', data => process.stdout.write(data));
  stream.stderr.on('data', data => process.stderr.write(data));
  stream.on('close', code => { process.exitCode = code || 0; conn.end(); });
  stream.end(programs[mode]);
})).on('error', err => { console.error(err.message); process.exitCode = 1; });
conn.connect({ host: env.DEPLOY_HOST, username: env.DEPLOY_USER, password: env.DEPLOY_PASSWORD, readyTimeout: 15000 });
