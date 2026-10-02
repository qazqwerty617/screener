'use strict';

// Confirmation-time model, NOT a promise of end-to-end transfer time. Exchange
// withdrawal review, batching, congestion and deposit processing are unknown.
// Use full blocks, not Flashblocks/preconfirmations. Reviewed 2026-10-02.
const BLOCKS = Object.freeze({
  BTC: { seconds:600, source:'https://developer.bitcoin.org/devguide/block_chain.html' },
  ETH: { seconds:12, source:'https://ethereum.org/developers/docs/consensus-mechanisms/pos/' },
  ARB: { seconds:.25, source:'https://research.arbitrum.io/t/the-power-of-faster-blocks/9609' },
  OP: { seconds:2, source:'https://specs.optimism.io/glossary.html' },
  BASE: { seconds:2, source:'https://blog.base.dev/flashblocks-deep-dive' },
  BSC: { seconds:.45, source:'https://docs.bnbchain.org/announce/fermi-bsc/' },
  TRX: { seconds:3, source:'https://developers.tron.network/docs/block' },
  LTC: { seconds:150, source:'https://github.com/litecoin-project/litecoin/blob/master/src/chainparams.cpp' },
  DOGE: { seconds:60, source:'https://github.com/dogecoin/dogecoin/blob/master/doc/FAQ.md' },
  ADA: { seconds:20, source:'https://cardano.org/glossary/active-slot-coefficient/' },
  OPBNB: { seconds:.25, source:'https://docs.bnbchain.org/announce/fourier-opbnb/' },
  POLYGON: { seconds:1, source:'https://polygon.technology/blog/polygon-speeds-up-by-33-with-madhugiri-hardfork' },
});

function confirmationTiming(network, confirmations) {
  const model=BLOCKS[network];
  if(!model || confirmations == null || !Number.isFinite(confirmations) || confirmations < 0) return null;
  return {ms:Math.max(1,confirmations)*model.seconds*1000,blockSeconds:model.seconds,
    source:model.source,basis:'deposit_confirmations_model',reviewedAt:'2026-10-02'};
}
module.exports={confirmationTiming};
