"use strict";
const { Client } = require('ssh2');
const fs = require('fs');

const host = String(process.env.DEPLOY_HOST || '').trim();
const username = String(process.env.DEPLOY_USER || '').trim();
const keyPath = String(process.env.DEPLOY_SSH_KEY_PATH || '').trim();
const passphrase = String(process.env.DEPLOY_SSH_KEY_PASSPHRASE || '');
const hostFingerprint = String(process.env.DEPLOY_HOST_FINGERPRINT_SHA256 || '').trim();
const pm2Process = String(process.env.DEPLOY_PM2_PROCESS || 'server').trim();

if (!host || !username || !keyPath || !hostFingerprint) throw new Error('Missing secure SSH configuration');
if (username.toLowerCase() === 'root') throw new Error('Refusing SSH connection as root');
if (!/^[A-Za-z0-9._-]{1,64}$/.test(pm2Process)) throw new Error('Unsafe DEPLOY_PM2_PROCESS');

const conn = new Client();
conn.on('ready', () => {
  console.log('[SSH] Connected');
  conn.exec(`pm2 logs ${pm2Process} --lines 50 --raw`, (err, stream) => {
    if (err) throw err;
    stream.on('data', data => console.log(data.toString()));
    stream.stderr.on('data', data => console.error(data.toString()));
    stream.on('close', () => conn.end());
  });
}).connect({
  host,
  port: 22,
  username,
  privateKey: fs.readFileSync(keyPath),
  passphrase: passphrase || undefined,
  hostHash: 'sha256',
  hostVerifier: keyHash => keyHash === hostFingerprint
});
