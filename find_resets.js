const fs = require('fs');
const s = fs.readFileSync('node-server/public/js/app.js', 'utf8');
const lines = s.split('\n');
lines.forEach((l, i) => {
  if (l.includes('setStoredAuthToken("")') || l.includes('authToken = ""') || l.includes('removeItem("obsidian_auth_token")') || l.includes('openAuthModal')) {
    console.log(i + 1, l.trim().slice(0, 120));
  }
});
