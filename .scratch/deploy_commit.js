const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const COMMIT = process.argv[2] || cp.execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
const BASE_COMMIT = process.argv[3] || '822e2b1';
const BUNDLE_PATH = path.join(__dirname, `bundle-${COMMIT.slice(0, 7)}.bundle`);
const REMOTE_TMP_BUNDLE = `/tmp/bundle-${COMMIT.slice(0, 7)}.bundle`;

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
    echo "--- Preserving live admin_settings.json ---"
    [ -f /root/nother/node-server/admin_settings.json ] && cp /root/nother/node-server/admin_settings.json /tmp/admin_settings.json.bak || true

    echo "--- Updating /root/nother ---"
    cd /root/nother
    git bundle verify ${REMOTE_TMP_BUNDLE}
    git fetch ${REMOTE_TMP_BUNDLE} main
    git reset --hard ${COMMIT}
    [ -f /tmp/admin_settings.json.bak ] && cp /tmp/admin_settings.json.bak /root/nother/node-server/admin_settings.json || true
    echo "nother HEAD is now: $(git log -1 --oneline)"

    echo "--- Updating /root/cryptoscreen ---"
    cd /root/cryptoscreen
    git fetch ${REMOTE_TMP_BUNDLE} main
    git reset --hard ${COMMIT}
    echo "cryptoscreen HEAD is now: $(git log -1 --oneline)"

    echo "--- Building go-scanner in cryptoscreen and nother ---"
    cd /root/cryptoscreen/go-scanner
    go test ./...
    go build -o scanner .
    chmod +x scanner

    cd /root/nother/go-scanner
    go test ./...
    go build -o scanner .
    chmod +x scanner

    echo "--- Running test suite on updated code ---"
    cd /root/nother/node-server
    node --test tests/serverHotPaths.test.js tests/giftPromo.test.js tests/paymentUi.test.js tests/eventsHub.test.js tests/newsVerification.test.js tests/asterArbitrageQuotes.test.js tests/hyperliquidArbitrageQuotes.test.js tests/arbitrageLifecycle.test.js tests/exchangeAnnouncements.test.js tests/unlocks.test.js tests/broadcastBuffer.test.js tests/closedCandleTicks.test.js tests/correlationIntegrity.test.js tests/densityLayoutLoad.test.js tests/eventsAuditUi.test.js tests/eventsStreamLoad.test.js tests/goScannerProxy.test.js tests/marketIntegrityAudit.test.js tests/vwapSession.test.js tests/auditRegressions.test.js tests/arbitrageProRequests.test.js

    echo "--- Restarting PM2 services ---"
    pm2 restart cryptoscreen-go || true
    pm2 startOrRestart /root/nother/node-server/ecosystem.config.js --only server --update-env
    sleep 3
    pm2 status

    echo "--- Verifying server API response ---"
    curl -s http://127.0.0.1:3000/api/tickers | head -c 80
    echo ""

    echo "--- Cleaning up bundle ---"
    rm -f ${REMOTE_TMP_BUNDLE} /tmp/admin_settings.json.bak
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
