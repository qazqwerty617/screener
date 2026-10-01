'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {assessNews} = require('../newsVerification');
const {createEventsHub,alertKind}=require('../eventsHub');
const publishedAt = Date.UTC(2026,9,1,14);
const reports = [
  ['https://cointelegraph.com/news/near-intents-attack', 'NEAR Intents Loses $3.8M in Malicious Attack After Helping With Bitget Hack'],
  ['https://decrypt.co/123/near-intents', 'NEAR Intents Hit by $3.8 Million Hack Days After Disputing Bitget North Korea Claims'],
  ['https://www.coindesk.com/markets/near-intents', "NEAR Intents Suffers $3.8M Exploit as Crypto's Brutal Year of Hacks Continues"],
  ['https://www.theblock.co/post/123/near-intents', 'NEAR Intents Pauses Services Following $3.8 Million Breach and Promises Full Compensation'],
].map(([url,title])=>({url,title,publishedAt,alertKind:'security',originVerified:true}));
test('independently worded reports of the same NEAR Intents incident reach the confirmed urgent feed',()=>{
  assert.equal(assessNews(reports[0],reports).status,'corroborated');
  assert.equal(assessNews(reports[0],reports).sources.length,4);
});
test('different victims, sums, prevented attacks, copies and common attribution are not corroboration',()=>{
  const first=reports[0];
  for(const change of [{title:reports[1].title.replace('NEAR Intents','Other Protocol')},
    {title:reports[1].title.replace('3.8','38')},{title:'NEAR Intents Prevents $3.8M Wallet Hack'},
    {title:first.title},{context:'According to Reuters'},{originVerified:false}]){
    assert.equal(assessNews(first,[first,{...reports[1],...change}]).status,'pending',JSON.stringify(change));
  }
});
test('a denial of the victim retracts the incident; denials about related incidents do not',()=>{
  const unrelated={...reports[1],title:'Bitget denies $3.8M breach after NEAR Intents attack'};
  assert.equal(assessNews(reports[0],[...reports,unrelated]).status,'corroborated');
  const own={...unrelated,title:'NEAR Intents denies $3.8M breach'};
  assert.equal(assessNews(reports[0],[...reports,own]).status,'disputed');
  const context={...reports[1],title:'NEAR Intents loses $3.8M in hack after denying Bitget breach'};
  assert.equal(assessNews(context,[context,reports[2]]).status,'corroborated');
});
test('compact-dollar attacks qualify without misclassifying contractual disputes',()=>{
  assert.equal(alertKind('Bybit hit by $80M attack'),'security');
  assert.equal(alertKind('Exchange faces $80M lawsuit for breach of contract'),null);
  assert.equal(alertKind('Crypto founders attack SEC policy'),null);
});
test('security language without the word hack is classified, confirmed, deduplicated and alerted end to end', async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'obsidian-news-'));
  const hub=createEventsHub({filePath:path.join(dir,'events.json'),now:()=>publishedAt+60000,translate:async title=>title,
    unlockService:{snapshot:()=>({rows:[],sources:{}}),refresh:async()=>{}}});
  t.after(()=>{hub.stop();fs.rmSync(dir,{recursive:true,force:true});});
  const events=[];hub.subscribe(e=>{if(e?.type==='urgent')events.push(e)});
  for(const report of reports){assert.equal(alertKind(report.title),'security');hub.ingestNews([{...report,id:report.url}]);}
  assert.equal(events.length,1,'one toast for one incident');
  assert.equal(hub.snapshot().news.length,1,'one card with sources from all reporters');
  assert.equal(hub.snapshot().news[0].priority,'urgent');
  assert.equal(hub.snapshot().news[0].verification.sources.length,4);
  assert.equal(hub.snapshot().developing.length,0);
});
