const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

function removeTempDirectory(directory) {
  try {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  } catch (error) {
    console.warn(`Could not remove runtime smoke directory ${directory}: ${error.code || error.message}`);
  }
}

async function main() {
  const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessbridge-runtime-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessbridge-runtime-user-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessbridge-runtime-ext-'));
  try {
    const exitCode = await runTests({
      version: process.env.SESSBRIDGE_TEST_VSCODE_VERSION || '1.136.1',
      extensionDevelopmentPath: path.resolve(__dirname, '..', 'extension'),
      extensionTestsPath: path.resolve(__dirname, 'runtime-smoke'),
      extensionTestsEnv: {
        SESSBRIDGE_CHANNEL_DIR: channelDir,
        SESSBRIDGE_RUNTIME_SMOKE: '1',
      },
      launchArgs: [
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-extensions',
        '--disable-gpu',
      ],
    });
    if (exitCode !== 0) {
      throw new Error(`VS Code runtime smoke exited with code ${exitCode}`);
    }
  } finally {
    removeTempDirectory(channelDir);
    removeTempDirectory(userDataDir);
    removeTempDirectory(extensionsDir);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
