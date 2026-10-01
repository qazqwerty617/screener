"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { parsePlanPages, planRows, officialPlanLink, createOfficialUnlockPlans,parsePdf } = require("../officialUnlockPlans");
const day = 86400000, now = Date.UTC(2026, 9, 1);
const page = lines => lines.map((line, i) => ({ str: line, transform: [1, 0, 0, 1, 30, 500 - i * 20] }));
const pages = [page(["Total Number of Tokens in Circulation (Month End-based Schedule)",
  "2026/09 1,000,000 SUI 2027/09 3,000,000 SUI", "2026/10 1,200,000 SUI 2027/10 3,250,000 SUI", "2026/11 1,400,000 SUI"] )];
test("project monthly supply tables are sorted across columns and never become daily cliffs", () => {
  const points = parsePlanPages(pages);
  assert.equal(points.length, 5);
  const rows = planRows({ symbol: "SUI", name: "Sui", url: "https://static.upbit.com/guide/circulating_supply/SUI_20260422.pdf", points }, now);
  const oct = rows.find(r => r.at === Date.UTC(2026, 9, 1));
  assert.equal(oct.amount, 200000); assert.equal(oct.precision, "month");
  assert.equal(oct.unlockType, "circulation"); assert.equal(oct.confidence, "project_plan");
  assert.equal(oct.windowEnd, Date.UTC(2026, 10, 1) - 1);
  assert.equal(rows.some(r => r.at === Date.UTC(2027, 8, 1)), false, "a gap has no computable monthly delta");
});
test("Korean split text dates and amounts use PDF geometry, not the PDF stream order", () => {
  const cells = [{str:"Month End-based Schedule",transform:[1,0,0,1,20,500]},
    ...["3", "월", "-26", "2,242,500,000"].map((str,i)=>({str,transform:[1,0,0,1,20+i*30,400]})),
    ...["4", "월", "-26", "2,296,041,667"].map((str,i)=>({str,transform:[1,0,0,1,20+i*30,380]}))].reverse();
  const points = parsePlanPages([cells]);
  assert.deepEqual(points.map(p=>p.at), [Date.UTC(2026,2,1),Date.UTC(2026,3,1)]);
  assert.equal(points[1].supply-points[0].supply,53541667);
});
test("unsupported tables, conflicting cells, and unsafe document origins fail closed", () => {
  assert.throws(()=>parsePlanPages([page(["Token prices", "2026/09 1,000,000", "2026/10 2,000,000"])]));
  assert.throws(()=>parsePlanPages([...pages,page(["2026/09 9,000,000"])]));
  assert.equal(officialPlanLink("https://static.upbit.com/guide/circulating_supply/SUI_20260422.pdf", "SUI")?.includes("SUI_"),true);
  for (const url of ["https://static.upbit.com.evil/guide/circulating_supply/SUI_20260422.pdf","https://user@static.upbit.com/guide/circulating_supply/SUI_20260422.pdf","https://static.upbit.com/guide/circulating_supply/WAL_20260422.pdf","http://static.upbit.com/guide/circulating_supply/SUI_20260422.pdf"]) assert.equal(officialPlanLink(url,"SUI"),null);
});
test("all catalog symbols are scanned progressively without a token cap; concurrent callers share work", async () => {
  const calls = []; let clock = now, parses = 0;
  const symbols = Array.from({length:35},(_,i)=>`ASSET${i}`);
  const service = createOfficialUnlockPlans({ now:()=>clock, filePath:null, batchSize:12,requestSpacingMs:0,
    parsePdf:async()=>{parses++;return parsePlanPages(pages);}, request:async url=>{
      calls.push(url);
      if(url.includes("market/all"))return Response.json(symbols.map(s=>({market:`KRW-${s}`,english_name:s})));
      if(url.endsWith(".json")) {const symbol=/\/([^/]+)\.json$/.exec(url)[1];return Response.json({success:true,data:{symbol,english_name:symbol,market_data:{project_team:{supply_plan:{link:`https://static.upbit.com/guide/circulating_supply/${symbol}_20261001.pdf`}}}}});}
      return new Response("%PDF-fixture",{headers:{etag:'"v1"'}});
    } });
  await Promise.all(Array.from({length:20},()=>service.refresh()));
  assert.equal(parses,12); assert.equal(service.snapshot().source.scannedTokens,12);
  clock+=20000;await service.refresh();clock+=20000;await service.refresh();
  assert.equal(service.snapshot().source.scannedTokens,35);assert.equal(service.snapshot().source.partial,false);
  const count=calls.length;clock+=20000;await service.refresh();assert.equal(calls.length,count,"daily TTL avoids repeated work");
  assert.equal(service.snapshot().rows.length,105);
  clock+=4*day;assert.equal(service.snapshot().rows.length,0,"expired remote schedules are not served silently");
});

test("rotated, offset and trailing-slash cells retain date-to-amount alignment",()=>{
  const cells=[{str:'Month End-based Schedule',transform:[0,10,-10,0,20,20]},
    ...[['2026/09/', '1,000,000'],['2026/10/','1,200,000']].flatMap((values,row)=>values.map((str,col)=>({str,transform:[0,10,-10,0,40+row*20+col*4,30+col*150]})))];
  assert.deepEqual(parsePlanPages([cells]),[{at:Date.UTC(2026,8,1),supply:1000000},{at:Date.UTC(2026,9,1),supply:1200000}]);
  assert.deepEqual(parsePlanPages([page(['Month End-based Schedule','2026/09/ 1,000,000','2026/10/ 1,200,000'])]),parsePlanPages([cells]));
  assert.deepEqual(parsePlanPages([page(['Month End-based Schedule','2026/09/ ( 1,000,000 )','2026/10/ ( 1,200,000 )'])]),parsePlanPages([cells]));
  assert.deepEqual(parsePlanPages([page(['Month End-based Schedule','2026.09. 1,000,000','2026.10. 1,200,000'])]),parsePlanPages([cells]));
});
test("US and European month-end dates are distinguished; ambiguous dates and prose are not quantities",()=>{
  for(const dates of [['9/30/2026','10/31/2026'],['30/9/2026','31/10/2026'],['9/30/26','10/31/26'],['Sep-26','October-26'],['9월-2026','10월-2026']]){
    assert.deepEqual(parsePlanPages([page(['Month End-based Schedule',dates[0]+' 1000000',dates[1]+' 1200000'])]),[{at:Date.UTC(2026,8,1),supply:1000000},{at:Date.UTC(2026,9,1),supply:1200000}]);
  }
  assert.throws(()=>parsePlanPages([page(['Month End-based Schedule','1/2/2026 1000000','2/3/2026 2000000'])]),/Ambiguous/);
  const points=parsePlanPages([...pages,page(['Notes: During Sep-26 the team proposed 4 votes on supply.','2026/10 9000000'])]);
  assert.equal(points.find(p=>p.at===Date.UTC(2026,9,1)).supply,1200000,'prose/footer must not override the table');
  assert.equal(parsePlanPages([...pages,page(['Notes: The DAO may mint from 01/01/26.'])]).length,5,'dates in footnotes cannot set table format');
});
test("known newer official revisions suppress obsolete project-submitted plans",()=>{
  const plan={symbol:'ZRO',points:parsePlanPages(pages),documentDate:'2024-06-20'};
  assert.equal(planRows(plan,now).length,0);
  assert.equal(planRows({...plan,documentDate:'2026-06-04'},now).length,3);
  assert.equal(planRows({...plan,symbol:'W',documentDate:'2025-10-14'},now).length,3);
  assert.equal(planRows({...plan,symbol:'JUP',documentDate:'2026-01-09'},now).length,0);
});

test("invalid full calendar dates fail closed rather than rolling into a valid month",()=>{
  for(const dates of [['2026/09/31','2026/10/31'],['9/31/2026','10/31/2026'],['31/9/2026','31/10/2026']]){
    assert.throws(()=>parsePlanPages([page(['Month End-based Schedule',dates[0]+' 1000000',dates[1]+' 1200000'])]),/Invalid table date/);
  }
});

test("bundled primary-document snapshot has bounded ordered monthly data and current provenance",()=>{
  const seed=require('../data-src/official-unlock-plans.json');
  assert.equal(seed.version,1);assert.equal(seed.catalog.length,new Set(seed.catalog).size);
  assert.equal(seed.entries.length,seed.catalog.length);
  assert.equal(seed.entries.length,new Set(seed.entries.map(e=>e.symbol)).size);
  for(const entry of seed.entries){
    assert.ok(seed.catalog.includes(entry.symbol));
    if(entry.url)assert.equal(officialPlanLink(entry.url,entry.symbol),entry.url);
    if(!entry.points?.length){assert.ok(['not_published','superseded','review_required'].includes(entry.status));continue;}
    assert.ok(entry.points.length>=2&&entry.points.length<=1200);
    for(const [i,p] of entry.points.entries()){
      const date=new Date(p.at);
      assert.equal(p.at,Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1));
      assert.ok(Number.isFinite(p.supply)&&p.supply>=0&&p.supply<=1e16);
      if(i)assert.ok(p.at>entry.points[i-1].at);
    }
    assert.ok(planRows(entry,now).every(row=>row.amount>0&&Number.isFinite(row.amount)&&row.precision==='month'&&row.confidence==='project_plan'));
  }
  assert.equal(seed.entries.find(e=>e.symbol==='JUP').status,'review_required');
  assert.equal(seed.entries.find(e=>e.symbol==='ZRO').status,'superseded');
});
const catalog = symbols => Response.json(symbols.map(s=>({market:`KRW-${s}`})));
const meta = (symbol,stamp='20261001') => Response.json({success:true,data:{symbol,english_name:symbol,market_data:{project_team:{supply_plan:{link:`https://static.upbit.com/guide/circulating_supply/${symbol}_${stamp}.pdf`}}}}});
test("provider rate limits halt the queue, obey Retry-After, then resume missing assets",async()=>{
  let clock=now,limited=true,calls=0;
  const service=createOfficialUnlockPlans({now:()=>clock,filePath:null,requestSpacingMs:0,parsePdf:async()=>parsePlanPages(pages),request:async url=>{
    calls++;if(url.includes('market/all'))return catalog(['SUI','APT','STRK']);
    if(url.endsWith('.json')){if(limited){limited=false;return new Response('slow down',{status:429,headers:{'Retry-After':'120'}});}return meta(/\/([^/]+)\.json$/.exec(url)[1]);}
    return new Response('%PDF-fixture');
  }});
  await service.refresh();assert.equal(service.snapshot().source.status,'rate_limited');
  assert.ok(calls<=3,'only current concurrent requests run');const count=calls;
  clock+=119000;await service.refresh();assert.equal(calls,count);
  clock+=2000;await service.refresh();assert.equal(service.snapshot().source.scannedTokens,3);
  assert.equal(service.snapshot().source.status,'ok');assert.equal(service.snapshot().source.errors,0);
});

test("a newer proposal is disclosed as a review requirement without asserting that its vote passed",async()=>{
  const service=createOfficialUnlockPlans({filePath:null,now:()=>now,requestSpacingMs:0,request:async url=>{
    if(url.includes('market/all'))return catalog(['JUP']);
    return meta('JUP','20260109');
  }});
  await service.refresh();const result=service.snapshot();
  assert.equal(result.rows.length,0);assert.equal(result.source.reviewRequired,1);assert.equal(result.source.superseded,0);
  assert.equal(result.source.excludedPlans[0].status,'review_required');
  assert.equal(result.source.excludedPlans[0].url,'https://discuss.jup.ag/t/proposal-net-zero-emissions/39948');
});
test("conditional PDFs, persisted restart, stale expiry and invalid identities preserve bounded truth",async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'official-plans-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filePath=path.join(dir,'plans.json');let clock=now,parses=0,fail=false;
  const options={filePath,now:()=>clock,requestSpacingMs:0,parsePdf:async()=>{parses++;return parsePlanPages(pages)},request:async(url,init)=>{
    if(fail)return new Response('unavailable',{status:500});
    if(url.includes('market/all'))return catalog(['SUI','FAKE','ZRO']);
    if(url.endsWith('FAKE.json'))return meta('SUI');
    if(url.endsWith('ZRO.json'))return meta('ZRO','20240620');
    if(url.endsWith('.json'))return meta('SUI');
    if(init.headers?.['If-None-Match']==='"stable"')return new Response(null,{status:304});
    return new Response('%PDF-fixture',{headers:{etag:'"stable"'}});
  }};
  const first=createOfficialUnlockPlans(options);await first.refresh();assert.equal(parses,1);
  assert.equal(first.snapshot().source.errors,1);assert.equal(first.snapshot().source.superseded,1);
  const restored=createOfficialUnlockPlans(options);assert.equal(restored.snapshot().source.availableTokens,3);
  assert.equal(restored.snapshot().rows.length,3);assert.equal(parses,1);
  clock+=day;await restored.refresh();assert.equal(parses,1,'304 does not reparse a PDF');
  assert.equal(restored.snapshot().rows[0].stale,false);
  fail=true;clock+=day;await restored.refresh();assert.equal(restored.snapshot().source.staleDocuments,1);
  assert.equal(restored.snapshot().rows.length,3);
  clock+=2*day;assert.equal(restored.snapshot().rows.length,0);assert.equal(restored.snapshot().source.expiredDocuments,1);
});
function fixturePdf(){
  const content='BT /F1 10 Tf 20 500 Td (Month End-based Schedule) Tj 0 -20 Td (2026/09 1000000) Tj 0 -20 Td (2026/10 1200000) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`});
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  pdf+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return new Uint8Array(Buffer.from(pdf));
}
test("actual PDF decoding stays off the event loop and malformed documents fail closed",async()=>{
  let ticks=0;const timer=setInterval(()=>ticks++,5);let points;
  try{points=await parsePdf(fixturePdf());}finally{clearInterval(timer);}
  assert.equal(points.length,2);assert.equal(points[1].supply,1200000);assert.ok(ticks>0,'server event loop runs while parsing');
  await assert.rejects(()=>parsePdf(new Uint8Array(Buffer.from('not a PDF'))),/Unsupported/);
});
