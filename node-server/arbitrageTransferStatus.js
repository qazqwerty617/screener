"use strict";

const PUBLIC_SOURCES = Object.freeze({
  BN: "https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll",
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
  ZKSYNCERA: "ZKSYNC", ZKSYNC: "ZKSYNC", LINEA: "LINEA", SCROLL: "SCROLL",
  OPBNB: "OPBNB", MANTLE: "MANTLE", BLAST: "BLAST", MODE: "MODE",
  AVALANCHEXCHAIN: "AVAX", AVAX: "AVAX", COSMOS: "ATOM", ATOM: "ATOM",
  POLKADOT: "DOT", DOT: "DOT", KUSAMA: "KSM", KSM: "KSM",
  CARDANO: "ADA", ADA: "ADA", ALGORAND: "ALGO", ALGO: "ALGO",
  RIPPLE: "XRP", XRP: "XRP", STELLAR: "XLM", XLM: "XLM",
  DOGECOIN: "DOGE", DOGE: "DOGE", LITECOIN: "LTC", LTC: "LTC",
  BITCOINCASH: "BCH", BCH: "BCH", ETHEREUMCLASSIC: "ETC", ETC: "ETC",
  KAVA: "KAVA", KAVAEVM: "KAVAEVM", KAIA: "KAIA", KLAYTN: "KAIA",
  OSMOSIS: "OSMO", OSMO: "OSMO", INJECTIVE: "INJ", INJ: "INJ",
  TERRA: "LUNA", TERRA2: "LUNA", LUNA: "LUNA", TERRACLASSIC: "LUNC", LUNC: "LUNC",
  ICP: "ICP", INTERNETCOMPUTER: "ICP", HEDERA: "HBAR", HBAR: "HBAR",
  APTOS: "APT", SUI: "SUI", STARKNET: "STRK", STRK: "STRK",
  RONIN: "RON", RON: "RON", CHILIZ: "CHZ", CHZ: "CHZ",
  THETA: "THETA", TEZOS: "XTZ", XTZ: "XTZ", WAX: "WAXP", WAXP: "WAXP",
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
      contractAddress: String(chain.contractAddress || chain.contract || "").trim() || null,
    }))
    .filter(chain => chain.network);
  if (normalized.length) map.set(base, normalized);
}

function normalizeBinance(payload) {
  const map = new Map();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  for (const coin of rows) {
    addCoin(map, coin.coin, (coin.networkList || []).map(chain => ({
      network: chain.network || chain.networkDisplay || chain.name,
      label: chain.networkDisplay || chain.name || chain.network,
      deposit: enabled(chain.depositEnable),
      withdraw: enabled(chain.withdrawEnable),
      fee: chain.withdrawFee,
      minWithdraw: chain.withdrawMin,
      contractAddress: chain.contractAddress,
    })));
  }
  return map;
}

function normalizeBybit(payload) {
  const map = new Map();
  for (const coin of Array.isArray(payload?.result?.rows) ? payload.result.rows : []) {
    addCoin(map, coin.coin, (coin.chains || []).map(chain => ({
      network: chain.chain || chain.chainType,
      label: chain.chainType || chain.chain,
      deposit: enabled(chain.chainDeposit),
      withdraw: enabled(chain.chainWithdraw),
      fee: chain.withdrawFee ?? chain.withdrawalFee,
      minWithdraw: chain.withdrawMin,
      contractAddress: chain.contractAddress,
    })));
  }
  return map;
}

function normalizeOkx(payload) {
  const map = new Map();
  const grouped = new Map();
  for (const row of Array.isArray(payload?.data) ? payload.data : []) {
    const coin = String(row.ccy || "").toUpperCase();
    if (!coin) continue;
    if (!grouped.has(coin)) grouped.set(coin, []);
    grouped.get(coin).push({
      network: String(row.chain || "").replace(new RegExp(`^${coin}-`, "i"), ""),
      label: row.chain,
      deposit: enabled(row.canDep),
      withdraw: enabled(row.canWd),
      fee: row.fee,
      minWithdraw: row.minWd,
      contractAddress: row.ctAddr,
    });
  }
  for (const [coin, chains] of grouped) addCoin(map, coin, chains);
  return map;
}

function normalizeMexc(payload) {
  const map = new Map();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  for (const coin of rows) {
    addCoin(map, coin.coin, (coin.networkList || []).map(chain => ({
      network: chain.network || chain.netWork || chain.name,
      label: chain.name || chain.network || chain.netWork,
      deposit: enabled(chain.depositEnable),
      withdraw: enabled(chain.withdrawEnable),
      fee: chain.withdrawFee,
      minWithdraw: chain.withdrawMin,
      contractAddress: chain.contract || chain.contractAddress,
    })));
  }
  return map;
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
      contractAddress: chain.contractAddress,
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
      contractAddress: chain.contract_address || chain.contractAddress,
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
      contractAddress: chain.contractAddress || chain.contract,
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
      contractAddress: chain.contractAddress,
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

function sameContract(a, b) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return true;
  return /^0x/i.test(left) && /^0x/i.test(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolveTransferRoute(catalogs, base, buyEx, sellEx) {
  const coin = String(base || "").toUpperCase();
  const buy = summarize(catalogs.get(buyEx)?.get(coin));
  const sell = summarize(catalogs.get(sellEx)?.get(coin));
  if (!buy.chains.length || !sell.chains.length) {
    return { status: "unknown", networks: [], buy, sell };
  }
  const sellDeposits = sell.chains.filter(chain => chain.deposit);
  const networks = [...new Set(buy.chains
    .filter(chain => chain.withdraw && sellDeposits.some(target =>
      canonicalNetwork(target.network) === canonicalNetwork(chain.network) && sameContract(chain.contractAddress, target.contractAddress)))
    .map(chain => canonicalNetwork(chain.network)))].sort();
  return { status: networks.length ? "open" : "closed", networks, buy, sell };
}

function createTransferStatusService(apiFetch, options = {}) {
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || 15 * 60_000);
  const retryMs = Math.max(5_000, Number(options.retryMs) || 60_000);
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const catalogs = new Map();
  const refreshedAt = new Map();
  let pending = null;

  const sources = [
    ["BN", PUBLIC_SOURCES.BN, normalizeBinance],
    ["BG", PUBLIC_SOURCES.BG, normalizeBitget],
    ["GT", PUBLIC_SOURCES.GT, normalizeGate],
    ["KC", PUBLIC_SOURCES.KC, normalizeKucoin],
    ["HT", PUBLIC_SOURCES.HT, normalizeHtx],
  ];

  async function refresh(force = false) {
    if (pending) return pending;
    const now = clock();
    const due = sources.filter(([code]) => force || now - (refreshedAt.get(code) || 0) >= (catalogs.has(code) ? ttlMs : retryMs));
    if (!due.length) return;
    pending = Promise.allSettled(due.map(([code, url, normalize]) =>
      apiFetch(url, 12_000, 1).then(data => [code, normalize(data)])
    )).then(results => {
      const finishedAt = clock();
      for (let index = 0; index < results.length; index++) {
        const code = due[index][0];
        const result = results[index];
        refreshedAt.set(code, finishedAt);
        if (result.status === "fulfilled" && result.value[1].size) {
          catalogs.set(code, result.value[1]);
        }
      }
    }).finally(() => { pending = null; });
    return pending;
  }

  async function getRoutes(routes, overlayCatalogs = null) {
    await refresh(false);
    const activeCatalogs = overlayCatalogs?.size ? new Map([...catalogs, ...overlayCatalogs]) : catalogs;
    return (Array.isArray(routes) ? routes : []).map(route => ({
      key: String(route.key || ""),
      base: String(route.base || "").toUpperCase(),
      ...resolveTransferRoute(activeCatalogs, route.base, route.buyEx, route.sellEx),
    }));
  }

  return { refresh, getRoutes, resolve: (base, buyEx, sellEx) => resolveTransferRoute(catalogs, base, buyEx, sellEx), catalogs, refreshedAt };
}

module.exports = {
  PUBLIC_SOURCES,
  canonicalNetwork,
  normalizeBinance,
  normalizeBybit,
  normalizeOkx,
  normalizeMexc,
  normalizeBitget,
  normalizeGate,
  normalizeKucoin,
  normalizeHtx,
  resolveTransferRoute,
  createTransferStatusService,
};
