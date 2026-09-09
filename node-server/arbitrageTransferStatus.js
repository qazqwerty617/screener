"use strict";

const PUBLIC_SOURCES = Object.freeze({
  BG: "https://api.bitget.com/api/v2/spot/public/coins",
  GT: "https://api.gateio.ws/api/v4/spot/currencies",
  KC: "https://api.kucoin.com/api/v3/currencies",
  HT: "https://api.huobi.pro/v2/reference/currencies",
});

const NETWORK_ALIASES = Object.freeze({
  BITCOIN: "BTC", BTC: "BTC",
  LIGHTNINGNETWORK: "LIGHTNING", LIGHTNING: "LIGHTNING", BTCLN: "LIGHTNING",
  ETHEREUM: "ETH", ETH: "ETH", ERC20: "ETH",
  TRON: "TRX", TRX: "TRX", TRC20: "TRX",
  BSC: "BSC", BEP20: "BSC", BNBSMARTCHAIN: "BSC",
  BNB: "BNB", BEP2: "BNB",
  SOLANA: "SOL", SOL: "SOL",
  ARBITRUM: "ARB", ARBITRUMONE: "ARB", ARBONE: "ARB", ARB: "ARB",
  OPTIMISM: "OP", OPTIMISTICETHEREUM: "OP", OP: "OP",
  POLYGON: "POLYGON", MATIC: "POLYGON", POL: "POLYGON",
  AVALANCHECCHAIN: "AVAXC", AVAXC: "AVAXC", CCHAIN: "AVAXC",
  BASE: "BASE", TON: "TON", SUI: "SUI", APTOS: "APT", APT: "APT",
  NEAR: "NEAR", CELO: "CELO", FANTOM: "FTM", FTM: "FTM",
});

function enabled(value) {
  return value === true || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "allowed" || String(value) === "1";
}

function canonicalNetwork(value) {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return NETWORK_ALIASES[raw] || raw;
}

function addCoin(map, coin, chains) {
  const base = String(coin || "").toUpperCase().trim();
  if (!base || !Array.isArray(chains)) return;
  const normalized = chains
    .map(chain => ({
      network: canonicalNetwork(chain.network),
      label: String(chain.label || chain.network || "").trim(),
      deposit: chain.deposit === null ? null : Boolean(chain.deposit),
      withdraw: chain.withdraw === null ? null : Boolean(chain.withdraw),
      fee: Number.isFinite(Number(chain.fee)) ? Number(chain.fee) : null,
      minWithdraw: Number.isFinite(Number(chain.minWithdraw)) ? Number(chain.minWithdraw) : null,
    }))
    .filter(chain => chain.network);
  if (normalized.length) map.set(base, normalized);
}

function normalizeBitget(payload) {
  const map = new Map();
  for (const coin of Array.isArray(payload?.data) ? payload.data : []) {
    addCoin(map, coin.coin, (coin.chains || []).map(chain => ({
      network: chain.chain,
      label: chain.chain,
      deposit: enabled(chain.rechargeable),
      withdraw: enabled(chain.withdrawable),
      fee: chain.withdrawFee,
      minWithdraw: chain.minWithdrawAmount,
    })));
  }
  return map;
}

function normalizeGate(payload) {
  const map = new Map();
  for (const coin of Array.isArray(payload) ? payload : []) {
    const chains = Array.isArray(coin.chains) && coin.chains.length ? coin.chains : [coin];
    addCoin(map, coin.currency, chains.map(chain => ({
      network: chain.name || chain.chain || coin.chain,
      label: chain.name || chain.chain || coin.chain,
      deposit: !(chain.deposit_disabled ?? coin.deposit_disabled),
      withdraw: !(chain.withdraw_disabled ?? coin.withdraw_disabled),
    })));
  }
  return map;
}

function normalizeKucoin(payload) {
  const map = new Map();
  const rows = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  for (const coin of rows) {
    addCoin(map, coin.currency, (coin.chains || []).map(chain => ({
      network: chain.chainName || chain.chainId,
      label: chain.chainName || chain.chainId,
      deposit: enabled(chain.isDepositEnabled),
      withdraw: enabled(chain.isWithdrawEnabled),
      fee: chain.withdrawMinFee ?? chain.withdrawalMinFee,
      minWithdraw: chain.withdrawMinSize ?? chain.withdrawalMinSize,
    })));
  }
  return map;
}

function normalizeHtx(payload) {
  const map = new Map();
  for (const coin of Array.isArray(payload?.data) ? payload.data : []) {
    addCoin(map, coin.currency || coin.ccy, (coin.chains || []).map(chain => ({
      network: chain.displayName || chain.baseChain || chain.chain,
      label: chain.displayName || chain.baseChain || chain.chain,
      deposit: enabled(chain.depositStatus),
      withdraw: enabled(chain.withdrawStatus),
      fee: chain.transactFeeWithdraw,
      minWithdraw: chain.minWithdrawAmt,
    })));
  }
  return map;
}

function summarize(chains) {
  if (!Array.isArray(chains) || !chains.length) return { deposit: null, withdraw: null, chains: [] };
  return {
    deposit: chains.some(chain => chain.deposit === true),
    withdraw: chains.some(chain => chain.withdraw === true),
    chains,
  };
}

function resolveTransferRoute(catalogs, base, buyEx, sellEx) {
  const coin = String(base || "").toUpperCase();
  const buy = summarize(catalogs.get(buyEx)?.get(coin));
  const sell = summarize(catalogs.get(sellEx)?.get(coin));
  if (!buy.chains.length || !sell.chains.length) {
    return { status: "unknown", networks: [], buy, sell };
  }
  const sellDeposits = new Set(sell.chains.filter(chain => chain.deposit).map(chain => canonicalNetwork(chain.network)));
  const networks = [...new Set(buy.chains
    .filter(chain => chain.withdraw && sellDeposits.has(canonicalNetwork(chain.network)))
    .map(chain => canonicalNetwork(chain.network)))].sort();
  return { status: networks.length ? "open" : "closed", networks, buy, sell };
}

function createTransferStatusService(apiFetch, options = {}) {
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || 15 * 60_000);
  const catalogs = new Map();
  let updatedAt = 0;
  let pending = null;

  async function refresh(force = false) {
    if (!force && updatedAt && Date.now() - updatedAt < ttlMs) return;
    if (pending) return pending;
    pending = Promise.allSettled([
      apiFetch(PUBLIC_SOURCES.BG, 12_000, 1).then(data => ["BG", normalizeBitget(data)]),
      apiFetch(PUBLIC_SOURCES.GT, 12_000, 1).then(data => ["GT", normalizeGate(data)]),
      apiFetch(PUBLIC_SOURCES.KC, 12_000, 1).then(data => ["KC", normalizeKucoin(data)]),
      apiFetch(PUBLIC_SOURCES.HT, 12_000, 1).then(data => ["HT", normalizeHtx(data)]),
    ]).then(results => {
      for (const result of results) {
        if (result.status === "fulfilled" && result.value[1].size) catalogs.set(result.value[0], result.value[1]);
      }
      updatedAt = Date.now();
    }).finally(() => { pending = null; });
    return pending;
  }

  async function getRoutes(routes) {
    await refresh(false);
    return (Array.isArray(routes) ? routes : []).map(route => ({
      key: String(route.key || ""),
      base: String(route.base || "").toUpperCase(),
      ...resolveTransferRoute(catalogs, route.base, route.buyEx, route.sellEx),
    }));
  }

  return { refresh, getRoutes, resolve: (base, buyEx, sellEx) => resolveTransferRoute(catalogs, base, buyEx, sellEx), catalogs };
}

module.exports = {
  PUBLIC_SOURCES,
  canonicalNetwork,
  normalizeBitget,
  normalizeGate,
  normalizeKucoin,
  normalizeHtx,
  resolveTransferRoute,
  createTransferStatusService,
};
