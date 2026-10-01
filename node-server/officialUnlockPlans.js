"use strict";

const fs = require("node:fs"), path = require("node:path"), { Worker } = require("node:worker_threads");
const DAY = 86400000;
const CATALOG_URL = "https://api.upbit.com/v1/market/all?is_details=false";
const DEFAULT_CACHE=path.join(__dirname,"data","official-unlock-plans.json");
const DEFAULT_SEED=path.join(__dirname,"data-src","official-unlock-plans.json");
const INFO_BASE = "https://api-manager.upbit.com/api/v1/coin_info/pub/";
const TOKEN = /^[A-Z0-9][A-Z0-9._-]{0,24}$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Old project-submitted PDFs must not undo a known, newer official revision.
const REVISIONS = {
  ZRO: { date: "2026-06-03", url: "https://layerzero.network/blog/the-zro-token" },
  W: { date: "2025-09-17", url: "https://wormhole.com/blog/wormhole-announces-w-token-2-0-upgrade" },
  IP: { date: "2026-08-04", url: "https://www.datafdn.org/blog/extending-the-data-lockup-building-from-proven-ground" },
  // A newer team proposal makes the older forecast unsafe to use as a current
  // schedule. This records a review requirement, not a claim that a vote passed.
  JUP: { date: "2026-02-13", url: "https://discuss.jup.ag/t/proposal-net-zero-emissions/39948", review: true },
};
function currentPlan(plan) {
  const revision = REVISIONS[plan.symbol];
  return !revision || typeof plan.documentDate === "string" && plan.documentDate >= revision.date;
}

function officialPlanLink(value, symbol) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "static.upbit.com" && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname.startsWith(`/guide/circulating_supply/${symbol}_`) &&
      /^\/guide\/circulating_supply\/[A-Z0-9._-]+\.pdf$/.test(url.pathname) ? url.href : null;
  } catch (_) { return null; }
}

function parsePlanPages(pages) {
  if (!Array.isArray(pages) || pages.length > 8) throw new Error("Unsupported plan pages");
  const lines = [];
  for (const items of pages) {
    if (!Array.isArray(items) || items.length > 25000) throw new Error("Plan too complex");
    const ordered = items.filter(item => typeof item.str === "string" && item.str.trim() &&
      Number.isFinite(item.transform?.[4]) && Number.isFinite(item.transform?.[5]))
      .map(item => {
        // Text matrices are in unrotated PDF space. Landscape/rotated pages
        // need a common text basis before matching a date to its quantity.
        const [a,b,,,x,y] = item.transform, length = Math.hypot(a,b);
        const cos = length ? a/length : 1, sin = length ? b/length : 0;
        return {str:item.str,transform:[1,0,0,1,x*cos+y*sin,-x*sin+y*cos]};
      })
      .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
    let row = [], y = null;
    const pageLines=[];
    const flush = () => { if (row.length) pageLines.push(row.sort((a,b)=>a.transform[4]-b.transform[4]).map(item=>item.str).join(" ")); row=[]; };
    for (const item of ordered) {
      // Cell baselines can differ by ~5pt in the official spreadsheets, while
      // adjacent monthly rows are separated by >10pt. Keep offset cells together.
      if (y !== null && Math.abs(item.transform[5] - y) > 5.5) flush();
      if (!row.length) y = item.transform[5];
      row.push(item);
    }
    flush();
    const footer=pageLines.findIndex(line=>/^\s*(?:Above monthly circulating|Notes?\s*(?::|$)|Project Contact Info)/i.test(line));
    lines.push(...(footer<0?pageLines:pageLines.slice(0,footer)));
  }
  if (!/Total Number of Tokens in Circulation|Month End[- ]based Schedule|월\s*말\s*기준/i.test(lines.join(" "))) throw new Error("Not a team supply plan");
  const slashDates=lines.flatMap(line=>[...line.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(20\d{2}|\d{2})\b/g)]
    .filter(m=>/^\s*\(?\s*\d/.test(line.slice(m.index+m[0].length))));
  const monthFirst=slashDates.some(m=>Number(m[2])>12),dayFirst=slashDates.some(m=>Number(m[1])>12);
  if(monthFirst&&dayFirst || slashDates.length&&!monthFirst&&!dayFirst)throw new Error("Ambiguous date format");
  const points = new Map();
  for (const line of lines) {
    const date = /\b(?<ymYear>20\d{2})\s*[-/.년]\s*(?<ymMonth>\d{1,2})(?:\s*[-/.]\s*(?<ymDay>\d{1,2})\b(?!\s*,))?\b|\b(?<dmyDay>\d{1,2})\s*\/\s*(?<dmyMonth>\d{1,2})\s*\/\s*(?<dmyYear>20\d{2}|\d{2})\b|\b(?<kMonth>\d{1,2})\s*월\s*[-/]\s*(?<kYear>20\d{2}|\d{2})\b|\b(?<namedMonth>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[- /]\s*(?<namedYear>20\d{2}|\d{2})\b|\b(?<shortMonth>\d{1,2})\s*-\s*(?<shortYear>\d{2})\b/gi;
    const matches = [...line.matchAll(date)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const g=m.groups,rawYear=g.ymYear||g.dmyYear||g.kYear||g.namedYear||g.shortYear;
      const year=Number(rawYear.length===2?`20${rawYear}`:rawYear);
      const month=g.namedMonth?MONTHS.indexOf(g.namedMonth.toLowerCase())+1:Number(g.ymMonth||(g.dmyYear?(monthFirst?g.dmyDay:g.dmyMonth):null)||g.kMonth||g.shortMonth);
      if (year < 2020 || year > 2100 || month < 1 || month > 12) continue;
      const day=g.ymDay ?? (g.dmyYear?(monthFirst?g.dmyMonth:g.dmyDay):null);
      if(day!=null&&(Number(day)<1||Number(day)>new Date(Date.UTC(year,month,0)).getUTCDate()))throw new Error("Invalid table date");
      const cell = line.slice(m.index + m[0].length, matches[i+1]?.index ?? line.length);
      if(!/^\s*[/.]?\s*\(?\s*\d/.test(cell))continue; // A table quantity must follow its date, not arbitrary prose.
      const values = [...cell.matchAll(/(?<![\w.,])(?:\d{1,3}(?:\s*,\s*\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w.,])/g)];
      if (values.length !== 1) continue; // Never choose an arbitrary number from prose.
      const supply = Number(values[0][0].replace(/[\s,]/g, "")), at = Date.UTC(year,month-1,1);
      if (!Number.isFinite(supply) || supply < 0 || supply > 1e16) continue;
      if (points.has(at) && points.get(at) !== supply) throw new Error("Conflicting plan cells");
      points.set(at,supply);
    }
  }
  if (points.size < 2 || points.size > 1200) throw new Error("Unsupported supply table");
  return [...points].sort((a,b)=>a[0]-b[0]).map(([at,supply])=>({at,supply}));
}

function planRows(plan, now = Date.now()) {
  if (!currentPlan(plan)) return [];
  const rows = [];
  for (let i=1;i<plan.points.length;i++) {
    const current=plan.points[i], previous=plan.points[i-1], date=new Date(previous.at);
    if (current.at !== Date.UTC(date.getUTCFullYear(), date.getUTCMonth()+1, 1)) continue;
    const amount=current.supply-previous.supply;
    if (!(amount>0) || current.at < now-90*DAY || current.at>now+365*DAY) continue;
    const end = new Date(current.at);
    rows.push({id:`project-plan:${plan.symbol}:${current.at}`,symbol:plan.symbol,name:plan.name,at:current.at,
      amount,allocations:[],totalSupply:null,percentSupply:null,precision:"month",windowStart:current.at,
      windowEnd:Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,1)-1,unlockType:"circulation",confidence:"project_plan",
      provider:"План команды · Upbit",sources:[plan.url],checkedAt:plan.updatedAt,
      documentDate:plan.documentDate,stale:!!plan.updatedAt && now-plan.updatedAt>=DAY,
      noteEn:"Planned monthly circulating-supply change. May include vesting, emissions and other releases; not a one-off cliff or evidence of a sale.",
      note:"Изменение планового обращения за месяц. Может включать вестинг, эмиссию и другие выпуски; это не разовый cliff и не подтверждение продажи."});
  }
  return rows;
}

async function parsePdf(data) {
  return new Promise((resolve,reject)=>{
    const worker = new Worker(path.join(__dirname,"officialUnlockPdfWorker.js"), {workerData:data,
      resourceLimits:{maxOldGenerationSizeMb:128,stackSizeMb:4}});
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error("PDF deadline exceeded")),15000);
    worker.once("message",message=>message.error?finish(new Error(message.error)):finish(null,message.points));
    worker.once("error",error=>finish(error));
    worker.once("exit",()=>{if(!settled)finish(new Error("PDF worker exited"));});
  });
}

async function readBuffer(response, maxBytes) {
  if (!response.ok || Number(response.headers.get("content-length"))>maxBytes) {
    await response.body?.cancel().catch(()=>{});throw new Error(`Document unavailable: ${response.status}`);
  }
  const chunks=[];let length=0;
  try {for await (const chunk of response.body) {length+=chunk.length;if(length>maxBytes)throw new Error("Document too large");chunks.push(chunk);}}
  finally {if(!response.body?.locked)await response.body?.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}

function createOfficialUnlockPlans({request=fetch,now=Date.now,parsePdf:decode=parsePdf,
  filePath=DEFAULT_CACHE,batchSize=12,requestSpacingMs=500}={}) {
  const entries=new Map();let catalog=[],catalogAt=0,catalogRetry=0,pending=null,batchAt=0,status="pending",cacheError=false,blockedUntil=0,nextRequestAt=0,revision=0,cached=null;
  // Only public schedules are persisted; a restart reuses already decoded PDFs.
  if(filePath)try {
    const cachePath=!fs.existsSync(filePath)&&filePath===DEFAULT_CACHE?DEFAULT_SEED:filePath;
    if(fs.statSync(cachePath).size>20000000)throw new Error("Cache too large");
    const saved=JSON.parse(fs.readFileSync(cachePath,"utf8"));
    if(saved.version===1 && Array.isArray(saved.catalog) && Number.isFinite(saved.catalogAt)) {
      catalog=[...new Set(saved.catalog.filter(s=>typeof s==='string'&&TOKEN.test(s)))];
      catalogAt=Math.min(saved.catalogAt,now());catalogRetry=catalogAt+DAY;status="cached";
    }
    if(saved.version===1 && Array.isArray(saved.entries))for(const entry of saved.entries){
      if(!TOKEN.test(entry.symbol))continue;
      if(["not_published","unsupported","superseded","review_required"].includes(entry.status)&&!entry.points?.length&&Number.isFinite(entry.checkedAt)){
        entries.set(entry.symbol,{symbol:entry.symbol,status:entry.status,url:officialPlanLink(entry.url,entry.symbol),documentDate:entry.documentDate,
          checkedAt:Math.min(entry.checkedAt,now()),retryAt:Math.min(entry.checkedAt,now())+DAY});continue;
      }
      if(!officialPlanLink(entry.url,entry.symbol)||!Number.isFinite(entry.updatedAt)||!Array.isArray(entry.points)||entry.points.length>1200)continue;
      if(entry.points.length<2||entry.points.some((p,i)=>!Number.isFinite(p.at)||!Number.isFinite(p.supply)||p.supply<0||p.supply>1e16||
        p.at!==Date.UTC(new Date(p.at).getUTCFullYear(),new Date(p.at).getUTCMonth(),1)||i>0&&p.at<=entry.points[i-1].at))continue;
      const updatedAt=Math.min(entry.updatedAt,now());
      entries.set(entry.symbol,{...entry,updatedAt,checkedAt:updatedAt,retryAt:updatedAt+DAY,status:"ok"});
    }
  }catch(error){if(error.code!=="ENOENT")cacheError=true;}
  async function get(url,options={}) {
    if(now()<blockedUntil)throw new Error("Provider backoff");
    const wait=Math.max(0,nextRequestAt-Date.now());nextRequestAt=Math.max(nextRequestAt,Date.now())+requestSpacingMs;
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
    if(now()<blockedUntil)throw new Error("Provider backoff");
    const response=await request(url,{...options,signal:AbortSignal.timeout(12000),redirect:"error"});
    if([429,503,403].includes(response.status)) {
      const retry=response.headers.get("retry-after"),seconds=Number(retry);
      const delay=retry&&Number.isFinite(seconds)?seconds*1000:retry?Date.parse(retry)-now():response.status===403?5*60000:60000;
      blockedUntil=now()+Math.max(1000,Math.min(DAY,Number.isFinite(delay)?delay:60000));status="rate_limited";
      await response.body?.cancel().catch(()=>{});throw new Error("Provider backoff");
    }
    return response;
  }
  async function persist() {
    if(!filePath)return;
    try {await fs.promises.mkdir(path.dirname(filePath),{recursive:true});const temp=`${filePath}.tmp`;
      await fs.promises.writeFile(temp,JSON.stringify({version:1,catalog,catalogAt,entries:[...entries.values()]}));
      await fs.promises.rename(temp,filePath);cacheError=false;
    }catch(_){cacheError=true;}
  }
  async function inspect(symbol) {
    const previous=entries.get(symbol),checkedAt=now();let stage="metadata",document={};
    try {
      const body=JSON.parse((await readBuffer(await get(`${INFO_BASE}${symbol}.json`),1000000)).toString("utf8"));
      if(body.success!==true||body.data?.symbol!==symbol)throw new Error("Invalid asset identity");
      const rawLink=body.data.market_data?.project_team?.supply_plan?.link;
      const url=officialPlanLink(rawLink,symbol);
      if(!url){entries.set(symbol,{symbol,status:rawLink?"unsupported":"not_published",checkedAt,retryAt:checkedAt+DAY});return;}
      const name=String(body.data.english_name||symbol).slice(0,100);
      const stamp=/_(20\d{6})\.pdf$/.exec(url)?.[1];
      const documentDate=stamp?`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6)}`:null;
      document={name,url,documentDate};
      if(!currentPlan({symbol,documentDate})) {
        entries.set(symbol,{symbol,...document,status:REVISIONS[symbol].review?"review_required":"superseded",checkedAt,retryAt:checkedAt+DAY});return;
      }
      stage="document";
      const headers=previous?.url===url&&previous.etag?{"If-None-Match":previous.etag}:{};
      const response=await get(url,{headers});
      if(response.status===304&&previous?.points?.length){entries.set(symbol,{...previous,name,checkedAt,updatedAt:checkedAt,retryAt:checkedAt+DAY,status:"ok"});return;}
      const data=await readBuffer(response,6000000);
      if(data.subarray(0,5).toString()!=="%PDF-")throw new Error("Not a PDF");
      stage="decode";
      const points=await decode(new Uint8Array(data));
      entries.set(symbol,{symbol,name,url,points,etag:response.headers.get("etag"),documentDate,checkedAt,updatedAt:checkedAt,retryAt:checkedAt+DAY,status:"ok"});
    }catch(_){entries.set(symbol,{...previous,...(!previous?.points?.length?document:{}),symbol,checkedAt,retryAt:now()<blockedUntil?blockedUntil:checkedAt+6*3600000,status:stage==="decode"?"unsupported":"error"});}
  }
  async function refresh() {
    if(pending)return pending;
    if(now()<Math.max(batchAt,blockedUntil))return;
    pending=(async()=>{
      batchAt=now()+20000;
      if(now()>=catalogRetry&&(!catalogAt||now()-catalogAt>=DAY)) {
        try {
          const payload=JSON.parse((await readBuffer(await get(CATALOG_URL),3000000)).toString("utf8"));
          if(!Array.isArray(payload)||!payload.length)throw new Error("Invalid market catalog");
          const symbols=[...new Set(payload.map(item=>String(item.market||"").split("-")[1]).filter(s=>TOKEN.test(s)))];
          if(!symbols.length)throw new Error("Empty symbol catalog");
          catalog=symbols;catalogAt=now();catalogRetry=now()+DAY;status="ok";
          const active=new Set(catalog);for(const symbol of entries.keys())if(!active.has(symbol))entries.delete(symbol);
        }catch(_){if(status!=="rate_limited")status="error";catalogRetry=Math.max(now()+5*60000,blockedUntil);}
      }
      const due=catalog.filter(symbol=>now()>=(entries.get(symbol)?.retryAt||0));
      // A work budget, not a coverage cap: the next poll continues the catalog.
      const queue=due.slice(0,Math.max(1,Math.min(32,batchSize)));
      let cursor=0;
      await Promise.all([0,1].map(async()=>{while(cursor<queue.length && now()>=blockedUntil){const symbol=queue[cursor++];await inspect(symbol);}}));
      if(status==="rate_limited"&&now()>=blockedUntil)status="ok";
      if(queue.length)await persist();
    })().finally(()=>{pending=null;revision++;cached=null;});
    return pending;
  }
  function snapshot() {
    const time=now(),minute=Math.floor(time/60000);
    if(cached?.revision===revision&&cached.minute===minute&&time<cached.expiresAt)return cached.value;
    const all=[...entries.values()],fresh=all.filter(e=>e.points?.length&&time-e.updatedAt<3*DAY&&currentPlan(e));
    const rows=fresh.flatMap(e=>planRows(e,time));
    const value={rows,source:{status,availableTokens:catalog.length||null,scannedTokens:catalog.filter(s=>entries.has(s)).length,
      documentedTokens:fresh.length,tokens:new Set(rows.filter(r=>r.windowEnd>=now()).map(r=>r.symbol)).size,
      errors:[...entries.values()].filter(e=>e.status==="error").length,
      unsupported:[...entries.values()].filter(e=>e.status==="unsupported").length,
      superseded:all.filter(e=>e.status==="superseded"||e.points?.length&&!currentPlan(e)&&!REVISIONS[e.symbol]?.review).length,
      reviewRequired:all.filter(e=>e.status==="review_required"||e.points?.length&&!currentPlan(e)&&REVISIONS[e.symbol]?.review).length,
      excludedPlans:all.filter(e=>e.status==="superseded"||e.status==="review_required"||e.points?.length&&!currentPlan(e)).map(e=>({symbol:e.symbol,documentDate:e.documentDate,
        status:REVISIONS[e.symbol]?.review?"review_required":"superseded",revisionDate:REVISIONS[e.symbol]?.date,url:REVISIONS[e.symbol]?.url})),
      staleDocuments:fresh.filter(e=>time-e.updatedAt>=DAY).length,
      expiredDocuments:all.filter(e=>e.points?.length&&time-e.updatedAt>=3*DAY).length,
      notPublished:[...entries.values()].filter(e=>e.status==="not_published").length,
      partial:!catalog.length||catalog.some(s=>!entries.has(s)||entries.get(s).status==="error"),catalogAt:catalogAt||null,retryAt:blockedUntil||null,
      cacheError,provider:"Планы команд · Upbit",provenance:"project_submitted",url:"https://support.upbit.com/hc/en-us/articles/14657848162329-Digital-Asset-Information-Tab"}};
    const expiresAt=Math.min(Infinity,...fresh.map(e=>e.updatedAt+(time-e.updatedAt<DAY?DAY:3*DAY)));
    cached={revision,minute,expiresAt,value};return value;
  }
  return {refresh,snapshot};
}
module.exports={createOfficialUnlockPlans,parsePlanPages,planRows,officialPlanLink,parsePdf,REVISIONS};
