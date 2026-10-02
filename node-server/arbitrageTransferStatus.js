"use strict";

const PUBLIC_SOURCES = Object.freeze({
  BN: "https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll",
  BG: "https://api.bitget.com/api/v2/spot/public/coins",
  GT: "https://api.gateio.ws/api/v4/spot/currencies",
  KC: "https://api.kucoin.com/api/v3/currencies",
  HT: "https://api.huobi.pro/v2/reference/currencies",
  PL: "https://api.poloniex.com/currencies?includeMultiChainCurrencies=true",
  BS: "https://www.bitstamp.net/api/v2/currencies/",
});

const NETWORK_ALIASES = Object.freeze({
  BITCOIN: "BTC", BTC: "BTC", SEGWITBTC:"BTC", BECH32:"BTC",
  LIGHTNINGNETWORK: "LIGHTNING", LIGHTNING: "LIGHTNING", BTCLN: "LIGHTNING",
  ETHEREUM: "ETH", ETH: "ETH", ERC20: "ETH",
  TRON: "TRX", TRX: "TRX", TRC20: "TRX",
  BSC: "BSC", BEP20: "BSC", BNBSMARTCHAIN: "BSC",
  BNB: "BNB", BEP2: "BNB",
  SOLANA: "SOL", SOL: "SOL",
  ARBITRUM: "ARB", ARBITRUMONE: "ARB", ARBONE: "ARB", ARB: "ARB", ETHARB:"ARB",
  OPTIMISM: "OP", OPTIMISTICETHEREUM: "OP", OP: "OP",
  OPMAINNET:'OP', ETHBASE:'BASE', ETHOP:'OP', ETHOPTIMISM:'OP',
  POLYGON: "POLYGON", MATIC: "POLYGON", POL: "POLYGON", POLPOLY:"POLYGON",
  AVALANCHECCHAIN: "AVAXC", AVAXC: "AVAXC", CCHAIN: "AVAXC",
  AVAXCCHAIN:'AVAXC', POLYGONPOS:'POLYGON', TON2:'TON', KCC:'KCC',
  PLASMA:'PLASMA', XPL:'PLASMA',
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
  if(value===null||value===undefined||value==='')return null;
  return value === true || ['true','allowed','enabled','1'].includes(String(value).toLowerCase());
}
function amountOrNull(value){return value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;}

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
      deposit: enabled(chain.deposit),
      withdraw: enabled(chain.withdraw),
      minWithdraw: amountOrNull(chain.minWithdraw),
      minDeposit: amountOrNull(chain.minDeposit),
      fee: amountOrNull(chain.fee),
      // Nonzero percentage/surcharges require a verified adapter formula;
      // keep them visible but do not silently treat them as a fixed-only fee.
      variableFee: amountOrNull(chain.variableFee),
      feeFormulaUnknown: chain.feeFormulaUnknown === true,
      depositFee: amountOrNull(chain.depositFee),
      confirmations: amountOrNull(chain.confirmations),
      withdrawStep: amountOrNull(chain.withdrawStep),
      withdrawPrecision: amountOrNull(chain.withdrawPrecision),
      needTag: enabled(chain.needTag),
      contractAddress: String(chain.contractAddress || chain.contract || "").trim() || null,
    }))
    .filter(chain => chain.network);
  if (normalized.length) map.set(base, [...(map.get(base) || []), ...normalized]);
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
      depositFee: chain.depositFee, minDeposit: chain.depositDust, confirmations: chain.minConfirm,
      withdrawStep: chain.withdrawIntegerMultiple,needTag:chain.withdrawIsTag,
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
      variableFee:chain.withdrawPercentageFee, minDeposit:chain.minDeposit, confirmations:chain.confirmation,
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
      confirmations:row.minDepArrivalConfirm,minDeposit:row.minDep,
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
      variableFee:chain.extraWithdrawFee,minDeposit:chain.minDepositAmount,confirmations:chain.depositConfirm,
      needTag:chain.needTag,withdrawStep:chain.withdrawStep,withdrawPrecision:chain.withdrawMinScale,
    })));
  }
  return map;
}

function normalizeGate(payload) {
  const map = new Map();
  for (const coin of Array.isArray(payload) ? payload : []) {
    const chains = Array.isArray(coin.chains) && coin.chains.length ? coin.chains : [coin];
    // Gate documents both ABC and ABC_CHAIN records for one traded asset.
    // Only remove an exact suffix matching the published chain identifier.
    const currency=String(coin.currency || '').toUpperCase();
    const suffix=String(coin.chain || '').toUpperCase();
    const base=suffix && currency.endsWith('_'+suffix) ? currency.slice(0,-suffix.length-1) : currency;
    if(coin.delisted === true) continue;
    addCoin(map, base, chains.map(chain => ({
      network: chain.name || chain.chain || coin.chain,
      label: chain.name || chain.chain || coin.chain,
      deposit: enabled(chain.deposit_disabled ?? coin.deposit_disabled)===null?null:!enabled(chain.deposit_disabled ?? coin.deposit_disabled),
      withdraw: enabled(chain.withdraw_disabled ?? coin.withdraw_disabled)===null?null:!enabled(chain.withdraw_disabled ?? coin.withdraw_disabled),
      contractAddress: chain.addr || chain.contract_address || chain.contractAddress,
      fee:chain.withdraw_fee??coin.withdraw_fee,minWithdraw:chain.withdraw_min??coin.withdraw_min,
    })));
  }
  return map;
}

function normalizeKucoin(payload) {
  const map = new Map();
  const rows = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  for (const coin of rows) {
    addCoin(map, coin.currency, (coin.chains || []).map(chain => ({
      network: chain.chainId || chain.chainName,
      label: chain.chainName || chain.chainId,
      deposit: enabled(chain.isDepositEnabled),
      withdraw: enabled(chain.isWithdrawEnabled),
      fee: chain.withdrawMinFee ?? chain.withdrawalMinFee,
      minWithdraw: chain.withdrawMinSize ?? chain.withdrawalMinSize,
      contractAddress: chain.contractAddress || chain.contract,
      variableFee:chain.withdrawFeeRate,minDeposit:chain.depositMinSize,confirmations:chain.confirms,
      needTag:chain.needTag,withdrawPrecision:chain.withdrawPrecision,
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
      minDeposit:chain.minDepositAmt,confirmations:chain.numOfConfirmations,
      variableFee:chain.transactFeeRateWithdraw,
      feeFormulaUnknown: Boolean(chain.withdrawFeeType && chain.withdrawFeeType !== 'fixed'),
      withdrawPrecision:chain.withdrawPrecision,needTag:chain.addrWithTag,
    })));
  }
  return map;
}

function normalizeBitstamp(payload) {
  const map=new Map();
  for(const coin of Array.isArray(payload) ? payload : []) {
    if(coin.type !== 'crypto') continue;
    addCoin(map,coin.currency,(coin.networks || []).map(chain=>({
      network:chain.network,label:chain.network,
      deposit:enabled(chain.deposit),withdraw:enabled(chain.withdrawal),
      minWithdraw:chain.withdrawal_minimum_amount,withdrawPrecision:chain.withdrawal_decimals,
      // The public catalogue does not supply withdrawal fees/contracts.
    })));
  }
  return map;
}

function normalizePoloniex(payload){
  const map=new Map(),grouped=new Map();
  const rows=Array.isArray(payload)?payload:[];
  for(const entry of rows)for(const [symbol,coin] of Object.entries(entry||{})){
    if(!coin||coin.delisted)continue;
    const base=coin.parentChain||symbol;
    if(!grouped.has(base))grouped.set(base,[]);
    grouped.get(base).push({network:coin.blockchain,label:coin.blockchain,
      deposit:coin.walletDepositState==='ENABLED'?true:coin.walletDepositState==='DISABLED'?false:null,
      withdraw:coin.walletWithdrawalState==='ENABLED'?true:coin.walletWithdrawalState==='DISABLED'?false:null,
      fee:coin.withdrawalFee,confirmations:coin.minConf,contractAddress:coin.contractAddress});
  }
  for(const [coin,chains] of grouped)addCoin(map,coin,chains);
  return map;
}

function summarize(chains) {
  if (!Array.isArray(chains) || !chains.length) return { deposit: null, withdraw: null, chains: [] };
  return {
    deposit: chains.some(chain => chain.deposit === true)?true:chains.some(chain=>chain.deposit==null)?null:false,
    withdraw: chains.some(chain => chain.withdraw === true)?true:chains.some(chain=>chain.withdraw==null)?null:false,
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
  const unknown=buy.chains.some(chain=>chain.withdraw===null)||sell.chains.some(chain=>chain.deposit===null);
  return { status: networks.length ? "open" : unknown?"unknown":"closed", networks, buy, sell };
}

function createTransferStatusService(apiFetch, options = {}) {
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || 2 * 60_000);
  const retryMs = Math.max(5_000, Number(options.retryMs) || 60_000);
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const catalogs = new Map();
  const refreshedAt = new Map();
  const successfulAt = new Map();
  const failures = new Set();
  let pending = null;

  const sources = [
    ["BN", PUBLIC_SOURCES.BN, normalizeBinance],
    ["BG", PUBLIC_SOURCES.BG, normalizeBitget],
    ["GT", PUBLIC_SOURCES.GT, normalizeGate],
    ["KC", PUBLIC_SOURCES.KC, normalizeKucoin],
    ["HT", PUBLIC_SOURCES.HT, normalizeHtx],
    ["PL", PUBLIC_SOURCES.PL, normalizePoloniex],
    ["BS", PUBLIC_SOURCES.BS, normalizeBitstamp],
  ];

  async function refresh(force = false) {
    if (pending) return pending;
    const now = clock();
    const due = sources.filter(([code]) => force || !refreshedAt.has(code) || now - refreshedAt.get(code) >= (catalogs.has(code)&&!failures.has(code) ? ttlMs : retryMs));
    if (!due.length) return;
    pending = Promise.allSettled(due.map(async ([code, url, normalize]) => {
      try {
        const catalog = normalize(await apiFetch(url, 12_000, 1));
        if (!catalog.size) { failures.add(code); return; }
        // Publish each successful response immediately. A timeout at another
        // venue must not delay healthy catalogues or renew stale data's age.
        catalogs.set(code, catalog);
        successfulAt.set(code, clock());
        failures.delete(code);
      } catch (_) {
        failures.add(code);
      } finally {
        refreshedAt.set(code, clock());
      }
    })).finally(() => { pending = null; });
    return pending;
  }

  async function getRoutes(routes, overlayCatalogs = null) {
    await refresh(false);
    const current=getCatalogSnapshot();
    const activeCatalogs = overlayCatalogs?.size ? new Map([...current.catalogs, ...overlayCatalogs]) : current.catalogs;
    return (Array.isArray(routes) ? routes : []).map(route => ({
      key: String(route.key || ""),
      base: String(route.base || "").toUpperCase(),
      ...resolveTransferRoute(activeCatalogs, route.base, route.buyEx, route.sellEx),
      checkedAt:Math.min(...[route.buyEx,route.sellEx].map(ex=>overlayCatalogs?.has(ex)?clock():successfulAt.get(ex)||0))||null,
    }));
  }

  function getCatalogSnapshot(){
    const time=clock(),fresh=new Map([...catalogs].filter(([ex])=>time-(successfulAt.get(ex)||0)<=ttlMs));
    return {catalogs:fresh,sources:Object.fromEntries(sources.map(([ex,url])=>[ex,{url,checkedAt:successfulAt.get(ex)||null,
      status:failures.has(ex)?'error':fresh.has(ex)?'ok':'pending',stale:catalogs.has(ex)&&!fresh.has(ex)}]))};
  }
  return { refresh, getRoutes, getCatalogSnapshot, resolve: (base, buyEx, sellEx) => resolveTransferRoute(getCatalogSnapshot().catalogs, base, buyEx, sellEx), catalogs, refreshedAt };
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
  normalizePoloniex,
  normalizeBitstamp,
  resolveTransferRoute,
  createTransferStatusService,
};
