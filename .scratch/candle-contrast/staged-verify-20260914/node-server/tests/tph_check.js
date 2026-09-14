async function testTPH() {
  try {
    const resp = await fetch('http://localhost:3000/api/tickers');
    const tickers = await resp.json();
    
    const bnTickers = tickers.filter(t => t.ex === 'BN' && !t.key.includes('_SPOT'));
    const bbTickers = tickers.filter(t => t.ex === 'BB' && !t.key.includes('_SPOT'));
    
    console.log('--- Binance TPH ---');
    bnTickers.slice(0, 10).forEach(t => {
      console.log(`${t.sym}: ${t.trades}`);
    });
    
    console.log('\n--- Bybit TPH ---');
    bbTickers.slice(0, 10).forEach(t => {
      console.log(`${t.sym}: ${t.trades}`);
    });
    
    const bnBtc = bnTickers.find(t => t.sym === 'BTCUSDT');
    const bbBtc = bbTickers.find(t => t.sym === 'BTCUSDT');
    
    console.log('\n--- BTC Comparison ---');
    console.log(`Binance BTC: ${bnBtc ? bnBtc.trades : 'N/A'}`);
    console.log(`Bybit BTC: ${bbBtc ? bbBtc.trades : 'N/A'}`);
    
  } catch (e) {
    console.error('Test failed:', e.message);
  }
}

setTimeout(testTPH, 60000); // Wait 60s for data to accumulate
