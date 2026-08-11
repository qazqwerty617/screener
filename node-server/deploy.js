"use strict";
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const HOST = String(process.env.DEPLOY_HOST || '').trim();
const USER = String(process.env.DEPLOY_USER || '').trim();
const SSH_KEY_PATH = String(process.env.DEPLOY_SSH_KEY_PATH || '').trim();
const SSH_KEY_PASSPHRASE = String(process.env.DEPLOY_SSH_KEY_PASSPHRASE || '');
const HOST_FINGERPRINT = String(process.env.DEPLOY_HOST_FINGERPRINT_SHA256 || '').trim();
const REMOTE_DIR = String(process.env.DEPLOY_REMOTE_DIR || '').trim();
const PM2_PROCESS = String(process.env.DEPLOY_PM2_PROCESS || 'server').trim();
const LOCAL_DIR = __dirname;

if (!HOST || !USER || !SSH_KEY_PATH || !HOST_FINGERPRINT || !REMOTE_DIR) {
  throw new Error('Missing secure deployment configuration; see .env.example');
}
if (USER.toLowerCase() === 'root') throw new Error('Refusing SSH deployment as root');
if (!/^\/[A-Za-z0-9._/-]+$/.test(REMOTE_DIR)) throw new Error('Unsafe DEPLOY_REMOTE_DIR');
if (!/^[A-Za-z0-9._-]{1,64}$/.test(PM2_PROCESS)) throw new Error('Unsafe DEPLOY_PM2_PROCESS');
if (!/^[A-Za-z0-9+/=:_-]{32,128}$/.test(HOST_FINGERPRINT)) throw new Error('Invalid host fingerprint');
const privateKey = fs.readFileSync(SSH_KEY_PATH);

const filesToUpload = [
  'server.js',
  'userStore.js',
  'telegramBot.js',
  'adminBot.js',
  'excelExporter.js',
  'paymentGateway.js',
  'paymentRoutes.js',
  'serverLevels.js',
  'wallScanner.js',
  'patternDetector.js',
  'tph_service.js',
  'package.json',
  'package-lock.json',
];

function getFilesRecursively(dir, rootDir = LOCAL_DIR) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        results = results.concat(getFilesRecursively(filePath, rootDir));
      }
    } else {
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
      results.push(relPath);
    }
  });
  return results;
}

const allFiles = [
  ...filesToUpload,
  ...getFilesRecursively(path.join(LOCAL_DIR, 'exchanges')),
  ...getFilesRecursively(path.join(LOCAL_DIR, 'public')),
];

console.log(`[DEPLOY] Total files to upload: ${allFiles.length}`);

conn.on('ready', () => {
  console.log('[SSH] Connected to ' + HOST);
  
  conn.sftp((err, sftp) => {
    if (err) throw err;
    
    let uploadedCount = 0;
    
    function uploadNext(index) {
      if (index >= allFiles.length) {
        console.log(`[SFTP] Successfully uploaded ${uploadedCount}/${allFiles.length} files!`);
        restartServer();
        return;
      }
      
      const relFile = allFiles[index];
      const localPath = path.join(LOCAL_DIR, relFile);
      const remotePath = `${REMOTE_DIR}/${relFile}`;
      
      // Ensure remote dir exists
      const remoteDir = path.dirname(remotePath).replace(/\\/g, '/');
      sftp.mkdir(remoteDir, { mode: 0o755 }, () => {
        sftp.fastPut(localPath, remotePath, (err) => {
          if (err) {
            console.error(`[SFTP ERROR] Failed to upload ${relFile}:`, err.message);
          } else {
            uploadedCount++;
            console.log(`[SFTP ${uploadedCount}/${allFiles.length}] Uploaded: ${relFile}`);
          }
          uploadNext(index + 1);
        });
      });
    }
    
    uploadNext(0);
  });
}).on('error', (err) => {
  console.error('[SSH ERROR]', err.message);
}).connect({
  host: HOST,
  port: 22,
  username: USER,
  privateKey,
  passphrase: SSH_KEY_PASSPHRASE || undefined,
  hostHash: 'sha256',
  hostVerifier: keyHash => keyHash === HOST_FINGERPRINT,
  readyTimeout: 30000,
});

function restartServer() {
  console.log('[DEPLOY] Restarting PM2 process on server...');
  conn.exec(`cd ${REMOTE_DIR} && npm ci --omit=dev --ignore-scripts && pm2 restart ${PM2_PROCESS} --update-env && pm2 list`, (err, stream) => {
    if (err) throw err;
    let out = '';
    stream.on('close', (code) => {
      console.log('[DEPLOY FINISHED OUTPUT]\n' + out);
      conn.end();
    }).on('data', (data) => {
      out += data.toString();
    }).stderr.on('data', (data) => {
      out += data.toString();
    });
  });
}
