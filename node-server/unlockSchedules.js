"use strict";

// Reviewed primary schedules, not claims of on-chain execution. Dates have day
// precision: midnight is a calendar key, not a promised execution timestamp.
const REVIEWED_AT = Date.parse("2026-09-26T00:00:00Z");
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
];

function primaryUnlocks(now = Date.now(), horizonDays = 365) {
  const rows = [];
  for (const schedule of SCHEDULES) {
    const start = new Date(`${schedule.start}T00:00:00Z`);
    const byDate = new Map();
    for (const allocation of schedule.allocations) {
      for (let month = allocation.firstMonth; month <= allocation.lastMonth; month++) {
        const at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + month, start.getUTCDate());
        if (at < now - 90 * 86400000 || at > now + horizonDays * 86400000) continue;
        const row = byDate.get(at) || { id: `primary:${schedule.symbol}:${at}`, symbol: schedule.symbol,
          name: schedule.name, geckoId: schedule.geckoId, at, amount: 0, allocations: [],
          totalSupply: schedule.totalSupply, sources: schedule.sources, provider: "Документация проекта",
          confidence: "schedule", precision: "day", reviewedAt: REVIEWED_AT };
        row.amount += allocation.amount;
        row.allocations.push({ label: allocation.label, amount: allocation.amount });
        byDate.set(at, row);
      }
    }
    for (const row of byDate.values()) rows.push({ ...row, percentSupply: row.amount / row.totalSupply * 100 });
  }
  return rows.sort((a, b) => a.at - b.at);
}

module.exports = { primaryUnlocks, SCHEDULES, REVIEWED_AT };
