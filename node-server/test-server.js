const { execSync } = require('child_process');
try {
  execSync('lsof -ti :3000 | xargs kill -9', {stdio: 'ignore'});
} catch (e) {}
