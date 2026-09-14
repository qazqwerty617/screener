const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const COMMIT = process.argv[2] || '41d64c7';
const BASE_COMMIT = process.argv[3] || '107fe87';
const BUNDLE_PATH = path.join(__dirname, `bundle-${COMMIT}.bundle`);
const REMOTE_TMP_BUNDLE = `/tmp/bundle-${COMMIT}.bundle`;

// Load .env for credentials
function loadDotEnv(envPath) {
  const result = {};
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      result[key] = val;
    }
  } catch (_) {}
  return result;
}

const rootEnv = loadDotEnv(path.join(__dirname, '..', '.env'));
const HOST_IP = rootEnv.DEPLOY_HOST || '169.58.138.33';
const USER = rootEnv.DEPLOY_USER || 'root';
const PASSWORD = rootEnv.DEPLOY_PASSWORD || '';

const askpass = path.join(os.tmpdir(), 'askpass_deploy.bat');
fs.writeFileSync(askpass, `@echo ${PASSWORD}\n`);
const env = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: '1' };

function sshCmd(cmd) {
  return cp.spawnSync('ssh', ['-o', 'StrictHostKeyChecking=no', `${USER}@${HOST_IP}`, cmd], {
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
}

async function run() {
  console.log(`[1] Creating git bundle for commit ${COMMIT} (range ${BASE_COMMIT}..main)...`);
  cp.execSync(`git bundle create "${BUNDLE_PATH}" ${BASE_COMMIT}..main`, {
    cwd: path.join(__dirname, '..')
  });
  console.log(`Bundle created at ${BUNDLE_PATH}, size: ${fs.statSync(BUNDLE_PATH).size} bytes`);

  console.log('[2] Uploading bundle to server...');
  const bundleContent = fs.readFileSync(BUNDLE_PATH);
  const uploadRes = cp.spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    `${USER}@${HOST_IP}`,
    `cat > ${REMOTE_TMP_BUNDLE}`
  ], {
    env,
    input: bundleContent,
    maxBuffer: 10 * 1024 * 1024
  });
  if (uploadRes.status !== 0) {
    throw new Error(`Failed to upload bundle: ${uploadRes.stderr}`);
  }
  console.log('Bundle uploaded successfully!');

  console.log('[3] Applying commit on /root/nother and /root/cryptoscreen...');
  const remoteScript = `
    set -e
    echo "--- Updating /root/nother ---"
    cd /root/nother
    git bundle verify ${REMOTE_TMP_BUNDLE}
    git fetch ${REMOTE_TMP_BUNDLE} main
    git reset --hard ${COMMIT}
    echo "nother HEAD is now: $(git log -1 --oneline)"

    echo "--- Updating /root/cryptoscreen ---"
    cd /root/cryptoscreen
    git fetch ${REMOTE_TMP_BUNDLE} main
    git reset --hard ${COMMIT}
    echo "cryptoscreen HEAD is now: $(git log -1 --oneline)"

    echo "--- Running test suite on updated code ---"
    cd /root/nother/node-server
    node --test tests/serverHotPaths.test.js tests/giftPromo.test.js tests/paymentUi.test.js

    echo "--- Restarting PM2 server ---"
    pm2 restart server --update-env
    sleep 3
    pm2 status

    echo "--- Cleaning up bundle ---"
    rm -f ${REMOTE_TMP_BUNDLE}
    echo "DEPLOY SUCCESSFUL"
  `;

  const runRes = sshCmd(remoteScript);
  console.log(runRes.stdout);
  if (runRes.stderr) {
    console.error(runRes.stderr);
  }
  if (runRes.status !== 0) {
    throw new Error(`Remote deployment failed with code ${runRes.status}`);
  }

  // Clean up local bundle
  try { fs.unlinkSync(BUNDLE_PATH); } catch (_) {}
}

try {
  run().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
} finally {
  try { fs.unlinkSync(askpass); } catch(_) {}
}
