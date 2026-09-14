"use strict";

const { EXCHANGES, extractBaseAndMultiplier } = require("./arbitrageEngine");

const DEX_SCREENER_BASE = "https://api.dexscreener.com/token-pairs/v1";

const CHAIN_IDS = Object.freeze({
  ETH: "ethereum", BSC: "bsc", SOL: "solana", BASE: "base", ARB: "arbitrum",
  OP: "optimism", POLYGON: "polygon", AVAXC: "avalanche", CELO: "celo",
  SCROLL: "scroll", LINEA: "linea", ZKSYNC: "zksync", SUI: "sui", APT: "aptos",
  TON: "ton", TRX: "tron", FTM: "fantom", KAVA: "kava", KAIA: "klaytn",
});

const CHAIN_PRIORITY = Object.freeze(["SOL", "BSC", "BASE", "ARB", "ETH", "POLYGON", "OP", "AVAXC"]);
const DEX_NAMES = Object.freeze({
  pancakeswap: "PancakeSwap", uniswap: "Uniswap", raydium: "Raydium", meteora: "Meteora",
  orca: "Orca", aerodrome: "Aerodrome", camelot: "Camelot", traderjoe: "Trader Joe",
  quickswap: "QuickSwap", sushiswap: "SushiSwap", curve: "Curve", balancer: "Balancer",
  velodrome: "Velodrome", thena: "Thena", cetus: "Cetus", stonfi: "STON.fi",
  dedust: "DeDust", sunswap: "SunSwap",
});

function addressKey(value) {
  const address = String(value || "").trim();
  return /^0x[0-9a-f]+$/i.test(address) ? address.toLowerCase() : address;
}

function titleCase(value) {
  const raw = String(value || "DEX").replace(/[-_]+/g, " ").trim();
  return raw.replace(/\b\w/g, char => char.toUpperCase());
}

function dexName(value) {
  const key = String(value || "").toLowerCase();
  return DEX_NAMES[key] || titleCase(key);
}

function tradeUrl(ex, sym) {
  const encoded = encodeURIComponent(sym || "");
  const urls = {
    BN: `https://www.binance.com/en/futures/${encoded}`,
    BB: `https://www.bybit.com/trade/usdt/${encoded}`,
    OX: `https://www.okx.com/trade-swap/${encoded.toLowerCase()}`,
    BG: `https://www.bitget.com/futures/usdt/${encoded}`,
    GT: `https://www.gate.com/futures/USDT/${encoded}`,
    MX: `https://futures.mexc.com/exchange/${encoded}`,
    KC: `https://www.kucoin.com/futures/trade/${encoded}`,
    BX: `https://bingx.com/en-us/perpetual/${encoded}`,
    HT: `https://www.htx.com/futures/linear_swap/exchange#contract_code=${encoded}`,
    HL: `https://app.hyperliquid.xyz/trade/${encoded}`,
    AD: `https://www.asterdex.com/en/futures/${encoded}`,
  };
  return urls[ex] || "#";
}

function collectVerifiedContracts(catalogs, bases, options = {}) {
  const wanted = new Set((Array.isArray(bases) ? bases : []).map(base => String(base || "").toUpperCase()).filter(Boolean));
  const limit = Math.max(1, Number(options.limit) || 120);
  const byIdentity = new Map();
  for (const [source, catalogue] of catalogs || []) {
    if (!(catalogue instanceof Map)) continue;
    for (const base of wanted) {
      for (const chain of catalogue.get(base) || []) {
        const network = String(chain.network || "").toUpperCase();
        const chainId = CHAIN_IDS[network];
        const contractAddress = String(chain.contractAddress || "").trim();
        if (!chainId || !contractAddress) continue;
        const id = `${chainId}:${addressKey(contractAddress)}`;
        const current = byIdentity.get(id);
        if (current && current.base !== base) continue;
        if (current) {
          if (!current.sources.includes(source)) current.sources.push(source);
        } else {
          byIdentity.set(id, { id, base, network, chainId, contractAddress, sources: [source] });
        }
      }
    }
  }
  return [...byIdentity.values()]
    .sort((a, b) => {
      const ai = CHAIN_PRIORITY.indexOf(a.network), bi = CHAIN_PRIORITY.indexOf(b.network);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.base.localeCompare(b.base);
    })
    .slice(0, limit);
}

function normalizeDexPairs(contract, payload) {
  const expectedAddress = addressKey(contract?.contractAddress);
  const expectedChain = String(contract?.chainId || "");
  if (!expectedAddress || !expectedChain) return [];
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.pairs) ? payload.pairs : [];
  const output = [];
  for (const pair of rows) {
    if (String(pair?.chainId || "").toLowerCase() !== expectedChain.toLowerCase()) continue;
    const baseAddress = addressKey(pair?.baseToken?.address);
    const quoteAddress = addressKey(pair?.quoteToken?.address);
    const tokenIsBase = baseAddress === expectedAddress;
    const tokenIsQuote = quoteAddress === expectedAddress;
    if (!tokenIsBase && !tokenIsQuote) continue;
    const baseUsd = Number(pair.priceUsd);
    const native = Number(pair.priceNative);
    const tokenPriceUsd = tokenIsBase ? baseUsd : (baseUsd > 0 && native > 0 ? baseUsd / native : 0);
    const liquidityUsd = Number(pair?.liquidity?.usd) || 0;
    if (!(tokenPriceUsd > 0) || !(liquidityUsd > 0)) continue;
    output.push({
      base: contract.base,
      network: contract.network,
      chainId: expectedChain,
      contractAddress: contract.contractAddress,
      contractSources: [...(contract.sources || [])],
      contractVerified: true,
      tokenSide: tokenIsBase ? "base" : "quote",
      tokenPriceUsd,
      dexId: String(pair.dexId || "dex").toLowerCase(),
      dexName: dexName(pair.dexId),
      pairAddress: String(pair.pairAddress || ""),
      pairUrl: String(pair.url || ""),
      quoteSymbol: String((tokenIsBase ? pair?.quoteToken?.symbol : pair?.baseToken?.symbol) || "USD").toUpperCase(),
      liquidityUsd,
      volume24hUsd: Number(pair?.volume?.h24) || 0,
      transactions5m: (Number(pair?.txns?.m5?.buys) || 0) + (Number(pair?.txns?.m5?.sells) || 0),
      transactions1h: (Number(pair?.txns?.h1?.buys) || 0) + (Number(pair?.txns?.h1?.sells) || 0),
      pairCreatedAt: Number(pair.pairCreatedAt) || 0,
    });
  }
  return output;
}

function cexQuotes(rows, options = {}) {
  const byBase = new Map();
  const now = Number(options.now) || Date.now();
  const maxAgeMs = Math.max(1_000, Number(options.maxCexAgeMs) || 15_000);
  const source = rows instanceof Map ? [...new Set(rows.values())] : (Array.isArray(rows) ? rows : []);
  for (const row of source) {
    if (row?.ex) {
      const identity = extractBaseAndMultiplier(row);
      const base = String(identity.base || "").toUpperCase();
      const factor = Number(identity.multiplier) || 1;
      const quoteTs = Number(row.quoteTs) || 0;
      const ageMs = quoteTs ? Math.max(0, now - quoteTs) : Infinity;
      const ask = Number(row.ask) / factor;
      const bid = Number(row.bid) / factor;
      if (!base || !row.ex || ageMs > maxAgeMs || (!(ask > 0) && !(bid > 0)) || Number(row.v) < 1_000) continue;
      if (!byBase.has(base)) byBase.set(base, new Map());
      const quote = {
        ex: row.ex, name: EXCHANGES[row.ex]?.name || row.ex, ask, bid, ageMs,
        url: tradeUrl(row.ex, row.sym),
      };
      const current = byBase.get(base).get(quote.ex);
      if (!current || quote.ageMs < current.ageMs) byBase.get(base).set(quote.ex, quote);
      continue;
    }
    const base = String(row.base || "").toUpperCase();
    if (!base) continue;
    const candidates = [
      { ex: row.buyEx, name: row.buyName, ask: Number(row.buyAsk) / (Number(row.buyMultiplier) || 1), bid: Number(row.buyBid) / (Number(row.buyMultiplier) || 1), ageMs: Number(row.ageMs) || 0, url: row.buyUrl },
      { ex: row.sellEx, name: row.sellName, ask: Number(row.sellAsk) / (Number(row.sellMultiplier) || 1), bid: Number(row.sellBid) / (Number(row.sellMultiplier) || 1), ageMs: Number(row.ageMs) || 0, url: row.sellUrl },
    ];
    if (!byBase.has(base)) byBase.set(base, new Map());
    for (const quote of candidates) {
      if (!quote.ex || (!(quote.ask > 0) && !(quote.bid > 0))) continue;
      const current = byBase.get(base).get(quote.ex);
      if (!current || quote.ageMs < current.ageMs) byBase.get(base).set(quote.ex, quote);
    }
  }
  return byBase;
}

function buildDexOpportunities(cexRows, dexPairs, options = {}) {
  const minLiquidityUsd = Math.max(1, Number(options.minLiquidityUsd) || 25_000);
  const minVolume24hUsd = Math.max(0, Number(options.minVolume24hUsd) || 5_000);
  const maxAbsGrossPct = Math.max(1, Number(options.maxAbsGrossPct) || 12);
  const notionalUsd = Math.max(10, Number(options.notionalUsd) || 1_000);
  const dexFeePct = Math.max(0, Number(options.dexFeePct) || 0.30);
  const cexFeePct = Math.max(0, Number(options.cexFeePct) || 0.06);
  const quotes = cexQuotes(cexRows, options);
  const rows = [];
  for (const pair of Array.isArray(dexPairs) ? dexPairs : []) {
    if (!pair.contractVerified || pair.liquidityUsd < minLiquidityUsd || pair.volume24hUsd < minVolume24hUsd) continue;
    if ((Number(pair.transactions5m) || 0) < 1 && (Number(pair.transactions1h) || 0) < 2) continue;
    const verifiedSources = new Set(pair.contractSources || []);
    const available = [...(quotes.get(String(pair.base || "").toUpperCase())?.values() || [])]
      .filter(quote => verifiedSources.has(quote.ex));
    if (!available.length) continue;
    const bestBuy = available.filter(item => item.ask > 0).reduce((best, item) => !best || item.ask < best.ask ? item : best, null);
    const bestSell = available.filter(item => item.bid > 0).reduce((best, item) => !best || item.bid > best.bid ? item : best, null);
    const dexPrice = Number(pair.tokenPriceUsd);
    const cexToDexGross = bestBuy ? ((dexPrice - bestBuy.ask) / bestBuy.ask) * 100 : -Infinity;
    const dexToCexGross = bestSell ? ((bestSell.bid - dexPrice) / dexPrice) * 100 : -Infinity;
    const direction = cexToDexGross >= dexToCexGross ? "cex_to_dex" : "dex_to_cex";
    const grossPct = direction === "cex_to_dex" ? cexToDexGross : dexToCexGross;
    if (!Number.isFinite(grossPct) || Math.abs(grossPct) > maxAbsGrossPct) continue;
    const priceImpactPct = Math.min(3, notionalUsd / pair.liquidityUsd * 100);
    const costsPct = cexFeePct + dexFeePct + priceImpactPct;
    const netPct = grossPct - costsPct;
    if (!(netPct > 0)) continue;
    const cex = direction === "cex_to_dex" ? bestBuy : bestSell;
    rows.push({
      key: `dex:${pair.chainId}:${pair.base}:${pair.pairAddress}:${cex.ex}:${direction}`,
      base: pair.base,
      network: pair.network,
      chainId: pair.chainId,
      contractAddress: pair.contractAddress,
      contractSources: pair.contractSources,
      contractMatch: "exact",
      direction,
      buyVenue: direction === "cex_to_dex" ? cex.name : pair.dexName,
      sellVenue: direction === "cex_to_dex" ? pair.dexName : cex.name,
      cexEx: cex.ex,
      cexName: cex.name,
      cexUrl: cex.url,
      cexPrice: direction === "cex_to_dex" ? cex.ask : cex.bid,
      dexId: pair.dexId,
      dexName: pair.dexName,
      dexPrice,
      pairAddress: pair.pairAddress,
      pairUrl: pair.pairUrl,
      quoteSymbol: pair.quoteSymbol,
      grossPct: Math.round(grossPct * 10000) / 10000,
      estimatedCostsPct: Math.round(costsPct * 10000) / 10000,
      netPct: Math.round(netPct * 10000) / 10000,
      liquidityUsd: pair.liquidityUsd,
      volume24hUsd: pair.volume24hUsd,
      notionalUsd,
      quality: "indicative",
      warning: "DEX price is an indexed pool price; verify an executable wallet quote before trading",
    });
  }
  return rows.sort((a, b) => b.netPct - a.netPct || b.liquidityUsd - a.liquidityUsd);
}

function createDexArbitrageService(apiFetch, transferService, getCexRows, options = {}) {
  const ttlMs = Math.max(30_000, Number(options.ttlMs) || 60_000);
  const forceMinAgeMs = Math.max(0, Number(options.forceMinAgeMs ?? 10_000));
  const historyLimit = Math.max(2, Math.min(2_160, Number(options.historyLimit) || 720));
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const history = new Map();
  let cache = { generatedAt: 0, rows: [], contracts: 0, pools: 0, venues: [], sources: ["DEX Screener"] };
  let pending = null;

  function recordHistory(rows, generatedAt) {
    for (const row of rows) {
      const points = history.get(row.key) || [];
      if (!points.length || points.at(-1)[0] !== generatedAt) {
        points.push([generatedAt, row.netPct, row.cexPrice, row.dexPrice, row.grossPct, row.estimatedCostsPct, row.liquidityUsd]);
      }
      history.set(row.key, points.slice(-historyLimit));
    }
    if (history.size > 2_000) {
      for (const key of [...history.keys()].slice(0, history.size - 1_600)) history.delete(key);
    }
  }

  async function refresh(force = false) {
    const maxAge = force ? Math.min(ttlMs, forceMinAgeMs) : ttlMs;
    if (cache.generatedAt && clock() - cache.generatedAt < maxAge) return cache;
    if (pending) return pending;
    pending = (async () => {
      await transferService.refresh(false);
      const currentCexRows = getCexRows();
      const cexRows = currentCexRows instanceof Map || Array.isArray(currentCexRows) ? currentCexRows : [];
      const quotes = cexQuotes(cexRows, { ...options, now: clock() });
      const bases = [...quotes.keys()];
      const contracts = collectVerifiedContracts(transferService.catalogs, bases, { limit: options.contractLimit || 80 });
      const requests = contracts.map(contract => {
        const url = `${DEX_SCREENER_BASE}/${encodeURIComponent(contract.chainId)}/${encodeURIComponent(contract.contractAddress)}`;
        return apiFetch(url, 12_000, 0).then(payload => ({ contract, payload }));
      });
      const settled = await Promise.allSettled(requests);
      const pools = [];
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        pools.push(...normalizeDexPairs(result.value.contract, result.value.payload));
      }
      const generatedAt = clock();
      const rows = buildDexOpportunities(cexRows, pools, { ...options, now: generatedAt });
      recordHistory(rows, generatedAt);
      cache = {
        generatedAt,
        rows,
        contracts: contracts.length,
        pools: pools.length,
        venues: [...new Set(pools.map(pool => pool.dexName))].sort(),
        sources: ["DEX Screener"],
      };
      return cache;
    })().finally(() => { pending = null; });
    return pending;
  }

  async function getSnapshot(filters = {}) {
    const current = await refresh(Boolean(filters.force));
    const search = String(filters.search || "").toUpperCase();
    const minNet = Number(filters.minNet) || 0;
    const minLiquidityUsd = Number(filters.minLiquidityUsd) || 0;
    const exchanges = new Set(Array.isArray(filters.exchanges) ? filters.exchanges : []);
    const limit = Math.max(1, Math.min(500, Number(filters.limit) || 200));
    const rows = current.rows.filter(row => (!search || row.base.includes(search) || row.dexName.toUpperCase().includes(search))
      && (!exchanges.size || exchanges.has(row.cexEx))
      && row.netPct >= minNet && row.liquidityUsd >= minLiquidityUsd).slice(0, limit);
    return { ...current, rows, total: current.rows.length, methodology: "contract + chain exact match; indicative pool price; fees and liquidity impact estimated" };
  }

  function getHistory(key) {
    const wanted = String(key || "");
    return { key: wanted, points: history.get(wanted) || [] };
  }

  return { refresh, getSnapshot, getHistory };
}

module.exports = {
  DEX_SCREENER_BASE,
  CHAIN_IDS,
  collectVerifiedContracts,
  normalizeDexPairs,
  buildDexOpportunities,
  createDexArbitrageService,
};
