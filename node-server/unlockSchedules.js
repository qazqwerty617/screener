"use strict";

// Reviewed primary schedules, not claims of on-chain execution. Dates have day
// or period precision: midnight is a calendar key, not an execution timestamp.
const REVIEWED_AT = Date.parse("2026-10-02T00:00:00Z");
const SCHEDULES = [
  { symbol: "XPL", name: "Plasma", geckoId: "plasma", start: "2025-09-25", totalSupply: 10e9,
    sources: ["https://www.plasma.org/company/blog/xpl-the-public-sale-and-its-role-in-the-plasma-ecosystem",
      "https://www.plasma.org/company/blog/plasma-mainnet-beta-and-xpl"],
    allocations: [
      { label: "Экосистема", firstMonth: 1, lastMonth: 36, amount: 3.2e9 / 36 },
      { label: "Команда и инвесторы · cliff", firstMonth: 12, lastMonth: 12, amount: 5e9 / 3 },
      { label: "Команда и инвесторы", firstMonth: 13, lastMonth: 36, amount: 5e9 * 2 / 3 / 24 },
    ] },
  { symbol: "ARB", name: "Arbitrum", geckoId: "arbitrum", start: "2023-03-16", totalSupply: 10e9,
    sources: ["https://docs.arbitrum.foundation/airdrop-eligibility-distribution"],
    allocations: [{ label: "Команда и инвесторы", firstMonth: 13, lastMonth: 48, amount: 4.447e9 / 48 }] },
  { symbol: "APT", name: "Aptos", geckoId: "aptos", start: "2022-10-12", totalSupply: 1e9,
    sources: ["https://aptosnetwork.com/currents/aptos-tokenomics-overview"],
    allocations: [
      { label: "Сообщество и фонд", firstMonth: 1, lastMonth: 120, amount: (510217359.767 - 125e6 + 165e6 - 5e6) / 120 },
      { label: "Команда и инвесторы", firstMonth: 13, lastMonth: 18, amount: (190e6 + 134782640.233) * 3 / 48 },
      { label: "Команда и инвесторы", firstMonth: 19, lastMonth: 48, amount: (190e6 + 134782640.233) / 48 },
    ] },
  { symbol: "STRK", name: "Starknet", geckoId: "starknet", start: "2024-04-15", totalSupply: 10e9,
    sources: ["https://docs.starknet.io/learn/protocol/strk"], upperBound: true,
    note: "Документация устанавливает максимальный выпуск. База процента — 10 млрд при создании; новая эмиссия стейкинга не включена.",
    allocations: [{label:"Ранние участники и инвесторы",firstMonth:0,lastMonth:11,amount:64e6},
      {label:"Ранние участники и инвесторы",firstMonth:12,lastMonth:35,amount:127e6}] },
  { symbol: "ZK", name: "ZKsync", geckoId: "zksync", start: "2025-06-01", totalSupply: 21e9, precision:"month", upperBound:true,
    sources: ["https://docs.zknation.io/zk-token/zk-token"],
    note:"Указан максимальный месячный выпуск команды и инвесторов. Документация не обещает точный день или фактический выпуск всего лимита.",
    allocations:[{label:"Команда и инвесторы · cliff",firstMonth:0,lastMonth:0,amount:21e9*.036},
      {label:"Команда и инвесторы",firstMonth:1,lastMonth:36,amount:21e9*.008}] },
  { symbol:"TIA",name:"Celestia",geckoId:"celestia",totalSupply:1e9,
    sources:["https://docs.celestia.org/learn/TIA/staking-governance-supply/"],
    note:"Непрерывный вестинг распределён по календарным месяцам. База процента — выпуск при genesis; вознаграждения стейкинга исключены.",
    linear:[{label:"R&D и экосистема",from:"2024-10-30",to:"2027-10-30",amount:267.9e6*.75},
      {label:"Первоначальная команда",from:"2024-10-30",to:"2026-10-30",amount:176.4e6*2/3}] },
  { symbol:"BERA",name:"Berachain",geckoId:"berachain-bera",totalSupply:500e6,
    sources:["https://docs.berachain.com/general/tokens/bera","https://blog.berachain.com/blog/berachain-airdrop-overview",
      "https://assets-cms.kraken.com/files/51n36hrp/facade/0add1afb90e8ef5bd7bcde967601a8004db73a47.pdf"],
    note:"Показаны команда и инвесторы. Другие распределения и PoL-эмиссия не включены; база процента — genesis, а не текущая общая эмиссия.",
    linear:[{label:"Команда и инвесторы",from:"2026-02-06",to:"2028-02-06",amount:(84e6+171.5e6)*5/6}] },
  {symbol:"ZRO",name:"LayerZero",geckoId:"layerzero",start:"2024-06-20",totalSupply:1e9,precision:"month",
    sources:["https://info.layerzero.foundation/introducing-zro-d39df554a9b7","https://layerzero.network/blog/the-zro-token"],
    note:"Стратегические партнёры: обновлённая месячная порция 12,7 млн после выкупа. Пере-заблокированные токены фонда до Zero mainnet исключены. Месячный период не задаёт время исполнения.",
    allocations:[{label:"Команда",firstMonth:24,lastMonth:35,amount:255e6/24},
      {label:"Стратегические партнёры · пересмотренный выпуск",firstMonth:24,lastMonth:35,amount:12.7e6}]},
  {symbol:"PYTH",name:"Pyth Network",geckoId:"pyth-network",start:"2023-11-20",totalSupply:10e9,precision:"month",
    sources:["https://docs.pyth.network/pyth-token/pyth-distribution","https://www.pyth.network/blog/guide-to-claiming-your-retrospective-airdrop-allocation"],
    note:"Официально указаны этапы 6, 18, 30 и 42 месяца. Точный день и объём этапа здесь не подтверждены; данные графика не заменяются догадкой.",
    allocations:[6,18,30,42].map(month=>({label:"Этап официального расписания",firstMonth:month,lastMonth:month,amount:null}))},
  {symbol:"ONDO",name:"Ondo",geckoId:"ondo-finance",start:"2024-01-18",totalSupply:10e9,
    sources:["https://docs.ondo.foundation/ondo-token","https://blog.ondo.foundation/unlocking-ondo-a-proposal-from-the-ondo-foundation/"],
    note:"Официальные этапы: 12, 24, 36, 48 и 60 месяцев после запуска. Объём этапа здесь не установлен; месячный план команды доступен отдельно, когда опубликован.",
    allocations:[12,24,36,48,60].map(month=>({label:"Этап официального расписания",firstMonth:month,lastMonth:month,amount:null}))},
];

function monthAt(start, month) {
  const target=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+month,1));
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(),target.getUTCMonth(),Math.min(start.getUTCDate(),last));
}

function primaryUnlocks(now = Date.now(), horizonDays = 365) {
  const rows = [];
  for (const schedule of SCHEDULES) {
    const start = new Date(`${schedule.start}T00:00:00Z`);
    const byDate = new Map();
    const base={symbol:schedule.symbol,name:schedule.name,geckoId:schedule.geckoId,totalSupply:schedule.totalSupply,
      sources:schedule.sources,provider:"Документация проекта",confidence:"schedule",reviewedAt:REVIEWED_AT,
      note:schedule.note,upperBound:!!schedule.upperBound};
    for (const allocation of schedule.allocations||[]) {
      for (let month = allocation.firstMonth; month <= allocation.lastMonth; month++) {
        const at = monthAt(start,month);
        if (at < now - 90 * 86400000 || at > now + horizonDays * 86400000) continue;
        const row = byDate.get(at) || {...base,id:`primary:${schedule.symbol}:${at}`,at,amount:0,allocations:[],unlockType:"scheduled",precision:schedule.precision||"day"};
        row.amount=allocation.amount===null||row.amount===null?null:row.amount+allocation.amount;
        row.allocations.push({ label: allocation.label, amount: allocation.amount });
        byDate.set(at, row);
      }
    }
    for(const allocation of schedule.linear||[]) {
      const from=Date.parse(`${allocation.from}T00:00:00Z`),to=Date.parse(`${allocation.to}T00:00:00Z`);
      const first=new Date(Math.max(from,now-90*86400000));
      for(let at=Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1);at<to&&at<=now+horizonDays*86400000;){
        const date=new Date(at),next=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
        const windowStart=Math.max(at,from),windowEnd=Math.min(next,to);
        const amount=allocation.amount*(windowEnd-windowStart)/(to-from);
        const id=`linear:${at}`,row=byDate.get(id)||{...base,id:`primary:${schedule.symbol}:linear:${at}`,at,amount:0,allocations:[],
          unlockType:"linear",precision:"period",windowStart,windowEnd:windowEnd-1};
        row.amount+=amount;row.allocations.push({label:allocation.label,amount});
        row.windowStart=Math.min(row.windowStart,windowStart);row.windowEnd=Math.max(row.windowEnd,windowEnd-1);
        byDate.set(id,row);at=next;
      }
    }
    for (const row of byDate.values()) {
      if(row.precision==="month") {const date=new Date(row.at);row.windowStart=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1);row.windowEnd=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)-1;}
      rows.push({...row,percentSupply:row.amount===null?null:row.amount/row.totalSupply*100});
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

module.exports = { primaryUnlocks, SCHEDULES, REVIEWED_AT, monthAt };
