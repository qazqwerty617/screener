const fs = require('fs');

const oldAllSvg = `data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect x=%223%22 y=%2210%22 width=%225%22 height=%228%22 rx=%221.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%225%22 y=%226%22 width=%221%22 height=%2214%22 rx=%220.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%229.5%22 y=%224%22 width=%225%22 height=%2212%22 rx=%221.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2211.5%22 y=%222%22 width=%221%22 height=%2218%22 rx=%220.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2216%22 y=%2212%22 width=%225%22 height=%226%22 rx=%221.5%22 fill=%22%23ff4560%22/%3E%3Crect x=%2218%22 y=%228%22 width=%221%22 height=%2212%22 rx=%220.5%22 fill=%22%23ff4560%22/%3E%3C/svg%3E`;

const newAllSvg = `data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%230D0F14%22/%3E%3Ccircle cx=%228%22 cy=%228%22 r=%223%22 fill=%22%23F0B90B%22/%3E%3Ccircle cx=%2216%22 cy=%228%22 r=%223%22 fill=%22%23F7A600%22/%3E%3Ccircle cx=%228%22 cy=%2216%22 r=%223%22 fill=%22%2300F0FF%22/%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%223%22 fill=%22%232EBD85%22/%3E%3C/svg%3E`;

// Update app.js
let app = fs.readFileSync('public/js/app.js', 'utf8');
let c1 = 0;
while (app.includes(oldAllSvg)) { app = app.replace(oldAllSvg, newAllSvg); c1++; }
fs.writeFileSync('public/js/app.js', app);
console.log('app.js: replaced', c1, 'ALL_EXC_IMG instances');

// Update index.html  
let html = fs.readFileSync('public/index.html', 'utf8');
let c2 = 0;
while (html.includes(oldAllSvg)) { html = html.replace(oldAllSvg, newAllSvg); c2++; }
fs.writeFileSync('public/index.html', html);
console.log('index.html: replaced', c2, 'ALL_EXC_IMG instances');
