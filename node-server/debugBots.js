"use strict";
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('[SSH] Connected');
  conn.exec('pm2 logs server --lines 50 --raw', (err, stream) => {
    if (err) throw err;
    stream.on('data', data => console.log(data.toString()));
    stream.stderr.on('data', data => console.error(data.toString()));
    stream.on('close', () => conn.end());
  });
}).connect({
  host: '169.58.138.33',
  port: 22,
  username: 'root',
  password: 'AQwaffwedcv'
});
