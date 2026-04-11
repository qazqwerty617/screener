const { execSync } = require('child_process');
execSync("curl -s 'https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT' > bnb.txt")
let fapi = require('./bnb.txt').price;
console.log("REST fAPI BTCUSDT:", fapi)
