const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const WAIT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (value && typeof value === 'object') {
          return value;
        }
      } catch (error) {
        lastError = error.message;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${filePath}${lastError ? `: ${lastError}` : ''}`);
}

function writeCommand(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tempPath, filePath);
}

exports.run = async function run() {
  const channelDir = process.env.SESSBRIDGE_CHANNEL_DIR;
  assert.ok(channelDir, 'SESSBRIDGE_CHANNEL_DIR must be provided by the launcher');
  fs.mkdirSync(channelDir, { recursive: true });

  const extension = vscode.extensions.getExtension('larsonzh.sessbridge');
  assert.ok(extension, 'larsonzh.sessbridge must be available in the test host');
  await extension.activate();
  assert.strictEqual(extension.isActive, true, 'SessionBridge extension must activate');

  const targetPid = process.ppid;
  const diagPath = path.join(channelDir, `diag_${targetPid}.json`);
  const diagnostics = await waitForJson(diagPath, WAIT_TIMEOUT_MS);
  assert.strictEqual(diagnostics.reason, 'extension_activated');
  assert.strictEqual(diagnostics.pid, targetPid);
  assert.strictEqual(diagnostics.hasChatNamespace, true);

  const requestId = `runtime-smoke-${Date.now()}-${process.pid}`;
  const commandPath = path.join(channelDir, `cmd_${targetPid}.json`);
  const receiptPath = path.join(channelDir, `res_${targetPid}.json`);
  writeCommand(commandPath, {
    schemaVersion: '1',
    requestId,
    mode: 'silent',
    priority: 'normal',
    message: '',
    targetPid,
    timeoutMs: WAIT_TIMEOUT_MS,
    createdAt: new Date().toISOString(),
    legacy: false,
  });

  const receipt = await waitForJson(receiptPath, WAIT_TIMEOUT_MS);
  assert.strictEqual(receipt.schemaVersion, '1');
  assert.strictEqual(receipt.requestId, requestId);
  assert.strictEqual(receipt.status, 'no_message');
  assert.strictEqual(receipt.mode, 'silent');
  assert.strictEqual(fs.existsSync(commandPath), false, 'Extension must consume the command file');

  console.log(JSON.stringify({
    status: 'pass',
    extensionVersion: diagnostics.extensionVersion,
    vscodeVersion: diagnostics.vscodeVersion,
    targetPid,
    requestId,
    receiptStatus: receipt.status,
  }));
};
