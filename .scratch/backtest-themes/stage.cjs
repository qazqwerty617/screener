const fs=require('fs'),cp=require('child_process');
const files=['node-server/server.js','node-server/public/js/app.js','node-server/public/css/app.css'];
let patch='';
for(const file of files){
 const before='.scratch/backtest-themes/before/'+file;
 const result=cp.spawnSync('git',['diff','--no-index','--',before,file],{encoding:'utf8',maxBuffer:5000000});
 if(result.status>1)throw new Error(result.stderr);
 patch+=result.stdout.replaceAll('a/'+before,'a/'+file);
}
const htmlPath='node-server/public/index.html';
const head=cp.execFileSync('git',['show','HEAD:'+htmlPath],{encoding:'utf8',maxBuffer:5000000});
const html=head.replace(/<div class="theme-grid">\s*(?:<div class="theme-opt[^\n]+\n\s*)+<\/div>/,'<div class="theme-grid" aria-label="Готовые цветовые схемы"></div>')
 .replace('</head>','    <script src="/js/appearanceThemes.js?v=1"></script>\n</head>')
 .replaceAll(/app\.js\?v=\d+/g,'app.js?v=2088').replaceAll(/app\.css\?v=\d+/g,'app.css?v=1012').replaceAll(/backtest\.js\?v=\d+/g,'backtest.js?v=2010');
if(html.includes('data-theme="dark"'))throw new Error('Old themes were not replaced');
fs.writeFileSync('.scratch/backtest-themes/head.html',head);
fs.writeFileSync('.scratch/backtest-themes/staged.html',html);
patch+=cp.spawnSync('git',['diff','--no-index','--','.scratch/backtest-themes/head.html','.scratch/backtest-themes/staged.html'],{encoding:'utf8'}).stdout
 .replaceAll('a/.scratch/backtest-themes/head.html','a/'+htmlPath).replaceAll('b/.scratch/backtest-themes/staged.html','b/'+htmlPath);
fs.writeFileSync('.scratch/backtest-themes/current.patch',patch);
const result=cp.spawnSync('git',['apply','--cached','--check','.scratch/backtest-themes/current.patch'],{encoding:'utf8'});
process.stdout.write(result.stdout+result.stderr);
process.exitCode=result.status;
