"use strict";
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const HOST = '169.58.138.33';
const USER = 'root';
const PASS = 'AQwaffwedcv';
const REMOTE_DIR = '/root/nother/node-server';
const LOCAL_DIR = __dirname;

const filesToUpload = [
  'server.js',
  'serverLevels.js',
  'wallScanner.js',
  'patternDetector.js',
  'tph_service.js',
  'package.json',
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
  password: PASS,
  readyTimeout: 30000,
});

function restartServer() {
  console.log('[DEPLOY] Restarting PM2 process on server...');
  conn.exec(`cd ${REMOTE_DIR} && npm install --omit=dev && pm2 restart server && pm2 list`, (err, stream) => {
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
