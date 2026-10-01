'use strict';

// Closed pages are shared by all readers, with independent keys for each venue,
// instrument, timeframe and cursor. The live tail keeps its existing cache.
function createHistoryPageStore({maxEntries=128,maxCandles=64000,maxPending=16,ttlMs=300000,timeoutMs=6000,now=Date.now}={}) {
  const cache=new Map(), pending=new Map();
  let retained=0;
  function remove(key) { const entry=cache.get(key); if(entry) retained-=entry.data.length; cache.delete(key); }
  function prune() {
    const time=now();
    for(const [key,entry] of cache) if(entry.expires<=time) remove(key);
    while(cache.size>maxEntries || retained>maxCandles) remove(cache.keys().next().value);
  }
  function get({ex,sym,tf,before},loader) {
    const cursor=Number(before);
    if(!Number.isFinite(cursor)||cursor<=0) return Promise.reject(new Error('Invalid history cursor'));
    const key=JSON.stringify([ex,sym,tf,cursor]);
    prune();
    const hit=cache.get(key);
    if(hit) { cache.delete(key); cache.set(key,hit); return Promise.resolve(hit.data); }
    if(pending.has(key)) return pending.get(key);
    if(pending.size>=maxPending) return Promise.reject(new Error('History request capacity reached'));
    let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('History request timed out')),timeoutMs);});
    const request=Promise.race([Promise.resolve().then(loader),deadline]).then(rows=>{
      if(!Array.isArray(rows)) throw new Error('Invalid history response');
      const sorted=new Map();
      for(const row of rows) {
        if(!row) throw new Error('Invalid historical candle');
        const c=Object.fromEntries(['t','o','h','l','c','v'].map(field=>[field,Number(row[field])]));
        if(!Object.values(c).every(Number.isFinite)||c.t<=0||c.o<=0||c.c<=0||c.l<=0||c.v<0||
          c.h<Math.max(c.o,c.l,c.c)||c.l>Math.min(c.o,c.h,c.c)) throw new Error('Invalid historical candle');
        if(c.t<cursor) sorted.set(c.t,c);
      }
      if(rows.length&&!sorted.size) throw new Error('History cursor did not advance or contains invalid candles');
      const data=[...sorted.values()].sort((a,b)=>a.t-b.t);
      remove(key); cache.set(key,{data,expires:now()+(data.length?ttlMs:30000)}); retained+=data.length; prune();
      return data;
    }).finally(()=>{clearTimeout(timer);if(pending.get(key)===request) pending.delete(key);});
    pending.set(key,request); return request;
  }
  return {get,stats:()=>({entries:cache.size,candles:retained,pending:pending.size})};
}
function parseHistoryResponse(ex, data, parser) {
  if (!data || data.success === false || data.status === 'error' ||
      (data.retCode != null && Number(data.retCode) !== 0) ||
      (data.code != null && String(data.code) !== (ex === 'KC' ? '200000' : ex === 'BG' ? '00000' : '0'))) {
    throw new Error('Historical candle request rejected');
  }
  const raw = ['BN','AD','GT','HL'].includes(ex) ? data : ex === 'BB' ? data.result?.list :
    ex === 'MX' && Array.isArray(data.data?.time) ? data.data.time : data.data;
  if (!Array.isArray(raw)) throw new Error('Invalid historical candle payload');
  const parsed = parser(ex, data);
  if (!Array.isArray(parsed) || raw.length !== parsed.length) throw new Error('Invalid historical candles');
  return parsed;
}
module.exports={createHistoryPageStore,parseHistoryResponse};
