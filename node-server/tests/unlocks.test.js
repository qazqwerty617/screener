"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { primaryUnlocks,SCHEDULES,monthAt } = require("../unlockSchedules");
const { normalizeEmissions, createUnlockService } = require("../unlockService");
const now = Date.UTC(2026, 8, 26);
test("XPL cliff and monthly ecosystem vesting are calculated separately from official schedules", () => {
  const rows = primaryUnlocks(now).filter(row => row.symbol === "XPL");
  const cliff = rows.find(row => row.at === Date.UTC(2026, 8, 25));
  assert.ok(Math.abs(cliff.amount - (5e9 / 3 + 3.2e9 / 36)) < 0.001);
  assert.equal(cliff.precision, "day");
  const next = rows.find(row => row.at === Date.UTC(2026, 9, 25));
  assert.ok(Math.abs(next.amount - (5e9 * 2 / 3 / 24 + 3.2e9 / 36)) < 0.001);
  assert.equal(next.sources.length, 2);
});
test("APT insider vesting ends at four years, community vesting continues", () => {
  const rows = primaryUnlocks(now).filter(row => row.symbol === "APT");
  assert.equal(rows.find(row => row.at === Date.UTC(2026, 9, 12)).allocations.length, 2);
  assert.equal(rows.find(row => row.at === Date.UTC(2026, 10, 12)).allocations.length, 1);
});
test("ARB monthly vesting never extends beyond its final anniversary", () => {
  const rows = primaryUnlocks(now).filter(row => row.symbol === "ARB");
  assert.ok(rows.every(row => row.at <= Date.UTC(2027, 2, 16)));
  assert.ok(Math.abs(rows[0].amount - 92645833.33333333) < 0.01);
});
const token = { gecko_id: "plasma", name: "Plasma", maxSupply: 10e9, circSupply: 2e9,
  sources: ["javascript:alert(1)", "https://plasma.org"], events: [
    { timestamp: now / 1000 + 86400, unlockType: "cliff", noOfTokens: [100, 200] },
    { timestamp: now / 1000 + 86400, unlockType: "linear", noOfTokens: [500000] },
    { timestamp: "bad", unlockType: "cliff", noOfTokens: [100] },
  ] };
test("aggregator parsing does not turn a linear emission into a cliff or invent a ticker", () => {
  const rows = normalizeEmissions([token, { ...token, gecko_id: "unmapped", name: "New project" }], now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, 300);
  assert.equal(rows[0].symbol, "XPL");
  assert.equal(rows[1].symbol, null);
  assert.deepEqual(rows[0].sources, ["https://plasma.org/"]);
});
test("unlock service shares requests, backs off on failure and marks stale cached results", async () => {
  let clock = now, calls = 0, fail = false;
  const service = createUnlockService({ apiKey: "test-key", publicSources: false, now: () => clock, request: async () => {
    calls++; return new Response(fail ? "offline" : JSON.stringify([token]), { status: fail ? 503 : 200 });
  } });
  await Promise.all(Array.from({ length: 30 }, () => service.refresh()));
  assert.equal(calls, 1);
  assert.equal(service.snapshot().sources.defillama.status, "ok");
  fail = true; clock += 3600001; await service.refresh(); await service.refresh();
  assert.equal(calls, 2);
  assert.equal(service.snapshot().sources.defillama.stale, true);
  assert.ok(service.snapshot().rows.some(row => row.provider === "DefiLlama"));
  clock += 86400000;
  assert.ok(service.snapshot().rows.every(row => row.provider !== "DefiLlama"));
});
test("public schedules work without an API key and disclose limited coverage", async () => {
  const service = createUnlockService({ apiKey: "", publicSources: false, now: () => now, request: () => { throw new Error("must not request paid data"); } });
  await service.refresh();
  assert.equal(service.snapshot().coverage, "primary_only");
  assert.equal(service.snapshot().sources.primary.tokens, SCHEDULES.length);
  assert.ok(service.snapshot().rows.length > 20);
});

test("Starknet caps stop at the stated final month; ZK retains monthly precision",()=>{
  const strk=primaryUnlocks(Date.UTC(2024,3,15),1300).filter(r=>r.symbol==='STRK');
  assert.equal(strk.length,36);
  assert.equal(strk.filter(r=>r.amount===64e6).length,12);
  assert.equal(strk.filter(r=>r.amount===127e6).length,24);
  assert.equal(strk.at(-1).at,Date.UTC(2027,2,15));assert.ok(strk.every(r=>r.upperBound));
  const zk=primaryUnlocks(Date.UTC(2025,5,1),1200).filter(r=>r.symbol==='ZK');
  assert.equal(zk.length,37);assert.equal(zk[0].amount,21e9*.036);
  assert.ok(zk.slice(1).every(r=>r.amount===21e9*.008));
  assert.ok(zk.every(r=>r.precision==='month'&&r.windowEnd>=r.windowStart));
  assert.equal(zk.at(-1).windowEnd,Date.UTC(2028,6,1)-1);
});
test("continuous vesting portions integrate to their complete allocation and stop at partial final months",()=>{
  for(const symbol of ['TIA','BERA']){
    const schedule=SCHEDULES.find(s=>s.symbol===symbol),start=Date.parse(schedule.linear[0].from);
    const rows=primaryUnlocks(start,1300).filter(r=>r.symbol===symbol);
    assert.ok(rows.every(r=>r.precision==='period'&&r.unlockType==='linear'));
    assert.ok(Math.abs(rows.reduce((sum,r)=>sum+r.amount,0)-schedule.linear.reduce((sum,a)=>sum+a.amount,0))<.0001);
    for(const phase of schedule.linear){
      const end=Date.parse(phase.to),parts=rows.flatMap(r=>r.allocations.filter(a=>a.label===phase.label).map(a=>({r,a})));
      assert.ok(parts.every(({r})=>r.windowStart>=start));
      assert.ok(Math.abs(parts.reduce((sum,{a})=>sum+a.amount,0)-phase.amount)<.0001);
      assert.equal(parts.at(-1).r.at,Date.UTC(new Date(end).getUTCFullYear(),new Date(end).getUTCMonth(),1));
    }
  }
  const tia=primaryUnlocks(now).filter(r=>r.symbol==='TIA');
  assert.equal(tia.find(r=>r.at===Date.UTC(2026,10,1)).allocations.length,1,'core contributors cease after October 30');
});
test("official unknown tranche amounts remain unknown rather than zero; month arithmetic clamps",()=>{
  const rows=primaryUnlocks(now);
  for(const symbol of ['PYTH','ONDO']) {
    const future=rows.find(r=>r.symbol===symbol&&r.at>now);
    assert.ok(future);assert.equal(future.amount,null);assert.equal(future.percentSupply,null);
  }
  assert.equal(monthAt(new Date('2024-01-31T00:00:00Z'),1),Date.UTC(2024,1,29));
  assert.equal(monthAt(new Date('2025-01-31T00:00:00Z'),1),Date.UTC(2025,1,28));
  assert.equal(rows.find(r=>r.symbol==='ZRO'&&r.at>=now).amount,255e6/24+12.7e6);
});
test("official coverage counts unique future projects without adding provider overlaps",()=>{
  const officialPlans={snapshot:()=>({rows:[{symbol:'XPL',amount:100,at:now+86400000,confidence:'project_plan'}],source:{status:'ok',tokens:1}}),refresh:async()=>{}};
  const service=createUnlockService({publicSources:false,officialPlans,now:()=>now});
  assert.equal(service.snapshot().sources.primary.totalOfficialTokens,SCHEDULES.length);
});
