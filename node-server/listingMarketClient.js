"use strict";

// The listing detector needs identifiers, activity and official schedule fields;
// loadMarkets() also builds trading indexes, currency/network models and copies
// every market. Retaining those for twelve clients exhausted the server heap.
// fetchMarkets() returns the same parsed market fields without those indexes.
const TIME_FIELDS = ["onboardDate", "launchTime", "contTdSwTime", "listTime", "expTime", "deliveryTime", "delisting_time"];
const MARKET_TYPES = {
  binance: ["spot", "linear"], bybit: ["spot", "linear"],
  okx: ["spot", "swap"], gate: ["spot", "swap"],
};

function createListingMarketClient(exchangeId, ccxt = require("ccxt")) {
  const options = {};
  if (MARKET_TYPES[exchangeId]) options.fetchMarkets = { types: MARKET_TYPES[exchangeId] };
  if (exchangeId === "gate") options.swap = { fetchMarkets: { settlementCurrencies: ["usdt"] } };
  const client = new ccxt[exchangeId]({ enableRateLimit: true, timeout: 12000,
    enableLastHttpResponse: false, enableLastJsonResponse: false, options });
  return {
    async loadMarkets() {
      // HIP-3 parsing uses the identifier mapping populated by fetchCurrencies.
      // Keep that prerequisite from CCXT's loadMarketsHelper, without building
      // the unrelated deposit/withdrawal catalogues of all the other venues.
      if (exchangeId === "hyperliquid") await client.fetchCurrencies();
      const markets = await client.fetchMarkets();
      const result = {};
      for (const market of Object.values(markets || {})) {
        if (!market || !market.symbol || !(market.spot || market.swap) || market.quote !== "USDT" ||
            market.swap && market.settle && market.settle !== "USDT") continue;
        const info = {};
        for (const key of TIME_FIELDS) {
          const value = market.info?.[key];
          if (value === null || ["string", "number", "boolean"].includes(typeof value)) info[key] = value;
        }
        result[market.symbol] = { symbol: market.symbol, base: market.base, quote: market.quote,
          settle: market.settle, spot: market.spot, swap: market.swap, active: market.active, info };
      }
      return result;
    },
    close() { return client.close?.(); },
  };
}

module.exports = { createListingMarketClient };
