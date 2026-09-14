const fs=require('fs'),path=require('path'),cp=require('child_process');
const files=cp.execFileSync('git',['diff','--cached','--name-only'],{encoding:'utf8'}).trim().split('\n');
for(const file of files){
 const target=path.join('.scratch/backtest-themes/verify',file);
 fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,cp.execFileSync('git',['show',':'+file],{maxBuffer:5000000}));
 if(file.endsWith('.js'))cp.execFileSync(process.execPath,['--check',target]);
}
const tests=files.filter(file=>file.includes('/tests/')).map(file=>path.join('.scratch/backtest-themes/verify',file));
const run=cp.spawnSync(process.execPath,['--test',...tests],{encoding:'utf8',env:{...process.env,NODE_PATH:path.resolve('node-server/node_modules')}});
process.stdout.write(run.stdout+run.stderr);process.exitCode=run.status;
