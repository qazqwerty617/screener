"use strict";
// Deploy only reviewed chart logic and its browser cache version. No credentials,
// dependencies, user records, unrelated source files or other PM2 apps are changed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('../../node-server/node_modules/ssh2');
const env=require('../../node-server/node_modules/dotenv').parse(fs.readFileSync(path.resolve(__dirname,'../../.env')));
const base='/root/nother/node-server';
const expected={
  'server.js':'7c49551d156940d7c39e9fe78dc27495f85051d8a149d249f98718bd6be1d823',
  'public/js/app.js':'b9de012b37d8117d15b845e680bbd69a73989630213b914aabad87d13a1f7b3a',
  'public/index.html':'2de03cf7794bf2a94183a736219d10b6cadf77faa463ac19fd498d07e16d27e5',
};
const multichart=process.argv[2]==='multichart';
const privacy=process.argv[2]==='privacy-history';
const fairness=process.argv[2]==='ticker-fairness';
const viewport=process.argv[2]==='history-viewport';
const grid3d=process.argv[2]==='grid-three-day';
const gridGeneral=process.argv[2]==='grid-all-timeframes';
const followup=gridGeneral || grid3d || viewport || fairness || privacy || multichart || ['snapshot-fix','heartbeat-fix'].includes(process.argv[2]);
if(followup){
  for(const f of Object.keys(expected))delete expected[f];
  expected['server.js']=process.argv[2]==='heartbeat-fix'
    ? 'f3d156f2ff54994faaad6ac3a2f2faa84ef9e5c287b91edca6a97bcbd333beee'
    : '7df7303f5860b59e69ddec7926e421a412ee2f3edaa8dc84faf5e82731fd9572';
}
if(multichart) Object.assign(expected, {
  'server.js':'f972923006b8aa7708a04c02244c4f9b8e13b2b35ef1073e1e5c56e9aabdb9d7',
  'public/js/app.js':'a294bb1025f7d425b975b85efa80300168556731dedd84746edf8cf9266d6483',
  'public/index.html':'1583a08564e77ada38c58abba9eaf209910bb41ea01ffdaf0f22f03da4abc0c0',
  'exchanges/mexc.js':'28d599f3861fd42589db8848aaf03750566d6411ad94cb6b37a4f27a8419582a',
});
if(privacy) Object.assign(expected, {
  'server.js':'59ccc3f13f001641e7e42c94ebdbdad5632c1da5f42f623c28bbf172bb5fca73',
  'public/js/app.js':'c40fe9e50d2ae163e710ba9193440cd1184ea3b41ae7674595133da7d245e3fc',
  'public/index.html':'ae41df851f07c08157048bf803544e18886f16d58989f5a0e435724579524368',
  'public/js/tradeOverlay.js':'b3a6e5824c5350cff9b72777e446b3a5a4d12812cfd3debb0c2e73f6f15ae9d1',
  'public/js/journal.js':'e08a05bc0ea0e4c3d11ac7f83dbf4f35610eeaf57b5dfa7827364bce3ceb9321',
  'journalCredentialStore.js':'2f0213753eb850ab1e8df7dc1324f41cfed316d0a929b60cfebc173c84060b13',
});
if(fairness) expected['server.js']='bf232496ad86eeb9446fe3645f7e2bf6504ae36f9c0aebaaefd4dc3b0dc27c24';
if(viewport) Object.assign(expected, {
  'server.js':'adb2889ce0a15b3f86b6db5f0db435cc9a11fbef69ed114383da9238c3f09513',
  'public/js/app.js':'705890c022a55a0fde47865d2988c440c3959eede3b1ff8478c51ed243bb6f7a',
  'public/index.html':'e80bde15d4c943cdd148aa0b4735060075e6ef6d5f65c88d4dc79d81d8f5b44d',
});
if(grid3d) Object.assign(expected, {
  'server.js':'38b9086cbcd31ed2278ca1cd64da071ed090848e109f04908318d7e3ae7150b0',
  'public/js/app.js':'bffaac67fdf1f7698d7f6828cadee970798f2c187cc7f1a50a520a3a8a03428e',
  'public/index.html':'9540989120c38007538fc156ba0f6737d960e3afdfebd40586eb3d79b39cf848',
});
if(gridGeneral) Object.assign(expected, {
  'server.js':'a176af21dbcab6dea974847e8bceb627ad719c318f70d116a3889dffddab5277',
  'public/js/app.js':'54e2760c3bde6306e1b2084bc19383826d9b9c8d69e009e066377868c0391f7a',
  'public/index.html':'671c4b89d7814ec5246674916e431f99134597f7c95d1a9a4b3866e61e2cf591',
});
const conn=new Client(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const exec=command=>new Promise((resolve,reject)=>conn.exec(command,(error,stream)=>{
  if(error)return reject(error);let out='';stream.on('data',b=>out+=b);stream.stderr.on('data',b=>out+=b);
  stream.on('close',code=>code?reject(new Error(out)):resolve(out));
}));
conn.on('ready',async()=>{
  try {
    const sftp=await new Promise((r,j)=>conn.sftp((e,s)=>e?j(e):r(s)));
    const read=f=>new Promise((r,j)=>{const chunks=[],s=sftp.createReadStream(f);s.on('data',b=>chunks.push(b));s.on('error',j);s.on('end',()=>r(Buffer.concat(chunks)));});
    const put=(local,remote)=>new Promise((r,j)=>sftp.fastPut(local,remote,e=>e?j(e):r()));
    for(const [f,oldHash] of Object.entries(expected)) {
      const old=await read(`${base}/${f}`);
      if(hash(old)!==oldHash)throw new Error(`Concurrent server change detected: ${f}`);
      const localBackup=path.join(__dirname,followup?`before-${process.argv[2]}`:'before',f);fs.mkdirSync(path.dirname(localBackup),{recursive:true});fs.writeFileSync(localBackup,old);
    }
    const backup=`${base}/backups/chart-loading-${Date.now()}`;
    await exec(`mkdir -p '${backup}/public/js' && cp '${base}/server.js' '${backup}/server.js' && cp '${base}/public/js/app.js' '${backup}/public/js/app.js' && cp '${base}/public/index.html' '${backup}/public/index.html'`);
    if(multichart) await exec(`mkdir -p '${backup}/exchanges' && cp '${base}/exchanges/mexc.js' '${backup}/exchanges/mexc.js'`);
    if(privacy) {
      await exec(`cp '${base}/public/js/tradeOverlay.js' '${backup}/public/js/tradeOverlay.js' && cp '${base}/public/js/journal.js' '${backup}/public/js/journal.js' && cp '${base}/journalCredentialStore.js' '${backup}/journalCredentialStore.js' && cp -p '${base}/journal_credentials.json' '${backup}/journal_credentials.json' && chmod 600 '${backup}/journal_credentials.json'`);
    }
    console.log(`Backup: ${backup}`);
    for(const f of Object.keys(expected)) {
      const local=path.resolve(__dirname,'../../node-server',f),target=`${base}/${f}.chart-loading-new`;
      await put(local,target);
      if(hash(await read(target))!==hash(fs.readFileSync(local)))throw new Error(`Upload mismatch: ${f}`);
    }
    for(const f of Object.keys(expected).filter(f=>f.endsWith('.js'))) await exec(`node --check < '${base}/${f}.chart-loading-new'`);
    for(const f of Object.keys(expected)) {
      if(hash(await read(`${base}/${f}`))!==expected[f])throw new Error(`Concurrent server change detected: ${f}`);
    }
    for(const f of Object.keys(expected)) await exec(`mv '${base}/${f}.chart-loading-new' '${base}/${f}'`);
    console.log(await exec(`cd '${base}' && pm2 restart server`));
    for(const f of Object.keys(expected)) console.log(JSON.stringify({file:f,sha256:hash(await read(`${base}/${f}`))}));
  } catch(error) {console.error(error.message);process.exitCode=1;}
  finally {conn.end();}
}).on('error',e=>{console.error(e.message);process.exitCode=1;});
conn.connect({host:env.DEPLOY_HOST,username:env.DEPLOY_USER,password:env.DEPLOY_PASSWORD,readyTimeout:15000});
