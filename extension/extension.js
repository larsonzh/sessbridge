// SessionBridge extension — two-way session bridge between VS Code
// Copilot Chat and external automation.  No UI automation (pywinauto / AHK).
//
// Protocol (see docs/RFC-sessbridge-channel-protocol-v1.md):
//   New channel (default %TEMP%/sessbridge, override SESSBRIDGE_CHANNEL_DIR):
//     cmd_<pid>.json  ← written by caller (outbound envelope, v1)
//     res_<pid>.json  → written by extension (inbound receipt, v1)
//     diag_<pid>.json → diagnostic / capability probe
//
//   Legacy channel (system temp dir, unchanged for whois compatibility):
//     vscode_chat_send_cmd_<pid>.json / vscode_chat_send_res_<pid>.json
//     vscode_chat_send_cmd.json       / vscode_chat_send_result.json (shared)
//
// Multi-instance routing: this extension only processes PID-scoped command
// files whose PID equals process.ppid (the main VS Code window PID).
//
// Modes:
//   visible  → chat panel delivery (clipboard + chat commands, same session)
//   silent   → vscode.lm direct, captures AI response (zero UI)
//   auto     → try silent first, fall back to visible

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- Identity / version ---------------------------------------------------
const EXTENSION_VERSION = '0.1.0';
const SCHEMA_VERSION = '1';
const MY_WINDOW_PID = process.ppid;

// ---- Tunable constants (override via environment) -------------------------
const POLL_MS = parseInt(process.env.SESSBRIDGE_POLL_MS, 10) || 300;
const PASTE_DELAY_MS = parseInt(process.env.SESSBRIDGE_PASTE_DELAY_MS, 10) || 150;
const SUBMIT_DELAY_MS = parseInt(process.env.SESSBRIDGE_SUBMIT_DELAY_MS, 10) || 100;
const DEFAULT_LM_RESPONSE_TIMEOUT_MS = parseInt(
  process.env.SESSBRIDGE_LM_RESPONSE_TIMEOUT_MS, 10) || 60000;
const STALE_FILE_MS = 24 * 60 * 60 * 1000; // RFC §4.4 retention (24h)
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const channelDir = (process.env.SESSBRIDGE_CHANNEL_DIR || '').trim() ||
  path.join(os.tmpdir(), 'sessbridge');
ensureDir(channelDir);

// ---- In-flight guard (per response-file path) -----------------------------
// A response file (res_<pid>.json, or a legacy equivalent) is a single slot:
// two concurrent commands targeting the same file would race to overwrite
// each other's receipt (whichever finishes last wins, the other looks like
// a false poll_timeout to its caller).  Serialize per response-file path and
// answer overlapping commands with status="busy" instead of silently
// clobbering the in-flight receipt.
const inFlightResFiles = new Set();
function isBusy(resFile) { return inFlightResFiles.has(resFile); }
function markBusy(resFile) { inFlightResFiles.add(resFile); }
function clearBusy(resFile) { inFlightResFiles.delete(resFile); }

// ---- Chat tool adapter (single seam to a specific chat tool) --------------
// SessionBridge currently targets VS Code Copilot Chat (SESSBRIDGE_CHAT_TOOL
// default = 'copilot').  Everything this extension knows about a specific
// chat tool lives here: panel command IDs + vscode.lm usage.  A future tool
// adapter (e.g. Continue) implements the same surface — panel command IDs
// or its own send API — while client/protocol stay unchanged.
const CHAT_TOOL = (process.env.SESSBRIDGE_CHAT_TOOL || 'copilot').trim().toLowerCase();
const TOOL_ADAPTERS = {
  copilot: {
    toolKey: 'copilot',
    panelCommands: {
      open: 'workbench.action.chat.open',
      focusInput: 'workbench.action.chat.focusInput',
      submit: 'workbench.action.chat.submit',
      queueMessage: 'workbench.action.chat.queueMessage',
      cancel: 'workbench.action.chat.cancel',
      removePending: 'workbench.action.chat.removeAllPendingRequests',
      paste: 'editor.action.clipboardPasteAction',
    },
    hasLmApi: () => typeof vscode.lm !== 'undefined' &&
      typeof vscode.lm.selectChatModels === 'function',
    selectModels: () => vscode.lm.selectChatModels({}),
    sendLm: (model, messages, options) => model.sendRequest(messages, options),
  },
  // Future tools add an adapter here:
  //   continue: { toolKey: 'continue', hasLmApi: ..., sendLm: ..., panelCommands: ... }
};
const ADAPTER = TOOL_ADAPTERS[CHAT_TOOL] || TOOL_ADAPTERS.copilot;

function runPanelCommand(name) {
  const cmd = ADAPTER.panelCommands[name];
  if (cmd) {
    try { return vscode.commands.executeCommand(cmd); } catch (_) {}
  }
  return Promise.resolve();
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) { /* ignore */ }
}

// ---- File path helpers ----------------------------------------------------
function newCmdFile(pid) { return path.join(channelDir, 'cmd_' + pid + '.json'); }
function newResFile(pid) { return path.join(channelDir, 'res_' + pid + '.json'); }
function newDiagFile(pid) { return path.join(channelDir, 'diag_' + pid + '.json'); }

// Legacy paths are ALWAYS in the OS temp dir (whois compatibility).
function legacyCmdForPid(pid) { return path.join(os.tmpdir(), 'vscode_chat_send_cmd_' + pid + '.json'); }
function legacyResForPid(pid) { return path.join(os.tmpdir(), 'vscode_chat_send_res_' + pid + '.json'); }
const LEGACY_CMD_SHARED = path.join(os.tmpdir(), 'vscode_chat_send_cmd.json');
const LEGACY_RES_SHARED = path.join(os.tmpdir(), 'vscode_chat_send_result.json');

// ---- Atomic write (temp + rename) -----------------------------------------
function writeResult(targetPath, data) {
  const tmp = targetPath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    try {
      fs.renameSync(tmp, targetPath);
    } catch (_) {
      // rename across devices etc. — fall back to direct write
      fs.writeFileSync(targetPath, JSON.stringify(data), 'utf-8');
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ---- Idempotent receipt replay (F1 residual race) --------------------------
// Receipts are written to a single slot per response path (res_<pid>.json).
// A caller that just sent request A may have its fresh receipt overwritten by
// a concurrent request B's `busy` answer (B's client deletes the res file
// right before writing its command, opening a small window).  Per RFC §4.4,
// clients retry reusing the SAME requestId, so we cache successful receipts
// and replay them on a repeat requestId instead of re-executing the side
// effect (paste / LM call).  Errors are NOT cached — a retry should really
// re-attempt.
const RECEIPT_CACHE_TTL_MS = 5 * 60 * 1000;
const RECEIPT_CACHE_MAX = 50;
const receiptCache = new Map(); // requestId -> {resPath, message, data, at}

function isSuccessfulReceipt(data) {
  if (!data || typeof data !== 'object') { return false; }
  if (typeof data.status === 'string') {
    return data.status === 'ok' || data.status === 'discovery';
  }
  return data.success === true;
}

// Reject a promise that never settles inside `ms` — used around
// model.sendRequest, which some LM providers (e.g. the DeepSeek vizard
// channel) may leave pending indefinitely.  Without this, a silent request
// can hang for the whole client timeout and never receive ANY receipt.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('timeout');
      err.__timeout = true;
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function writeReceipt(resPath, data, requestId, message) {
  writeResult(resPath, data);
  if (requestId && isSuccessfulReceipt(data)) {
    receiptCache.set(requestId, {
      resPath: resPath, message: message || '', data: data, at: Date.now(),
    });
    while (receiptCache.size > RECEIPT_CACHE_MAX) {
      const oldest = receiptCache.keys().next().value;
      if (oldest === undefined) { break; }
      receiptCache.delete(oldest);
    }
  }
}

function replayIfCached(requestId, resFile, message) {
  if (!requestId) { return false; }
  const cached = receiptCache.get(requestId);
  if (!cached) { return false; }
  if (Date.now() - cached.at > RECEIPT_CACHE_TTL_MS) {
    receiptCache.delete(requestId);
    return false;
  }
  if (cached.resPath !== resFile || cached.message !== message) { return false; }
  writeResult(resFile, cached.data); // replay: no side effect re-execution
  return true;
}

// ---- Command normalization -------------------------------------------------
// Returns a normalized command object or null.  `isLegacyFile` pins the
// response schema to the legacy shape so whois clients keep working.
//
// F9: legacy detection is now STRICT — it follows the channel file location
// (isLegacyFile) or an explicit `legacy: true` flag only.  The previous
// heuristic (raw.request_id present && no schemaVersion => legacy) could
// silently switch a malformed NEW-protocol envelope (e.g. mistyped
// `request_id` instead of `requestId`) into the legacy dialect with no
// diagnostic.  New-protocol files must carry schemaVersion '1'; anything
// else is rejected as an invalid payload (fail-close, like ProofRail's
// requirement of explicit contract recognition).
function normalizeCommand(raw, isLegacyFile) {
  if (!raw || typeof raw !== 'object') { return null; }
  const legacy = !!isLegacyFile || raw.legacy === true;
  if (!legacy) {
    if (raw.schemaVersion !== SCHEMA_VERSION) { return null; }
  }
  const mode = String(raw.mode || 'visible').trim().toLowerCase();
  return {
    legacy: legacy,
    requestId: String(raw.requestId || raw.request_id || ''),
    mode: ['visible', 'silent', 'auto'].indexOf(mode) >= 0 ? mode : 'visible',
    priority: String(raw.priority || 'normal').trim().toLowerCase() === 'high' ? 'high' : 'normal',
    message: String(raw.message || ''),
    model: String(raw.model || '').trim().toLowerCase(),
    modelOptions: (typeof raw.model_options === 'object' && raw.model_options !== null)
      ? raw.model_options : {},
    isDiscover: raw.discover === true,
    lmResponseTimeoutMs: (typeof raw.lm_response_timeout_ms === 'number' && raw.lm_response_timeout_ms > 0)
      ? raw.lm_response_timeout_ms : undefined,
    conversationId: raw.conversationId !== undefined ? String(raw.conversationId) : '',
    turnId: typeof raw.turnId === 'number' ? raw.turnId : undefined,
    targetPid: typeof raw.targetPid === 'number' ? raw.targetPid : undefined,
  };
}

// ---- Response writers ------------------------------------------------------
function newResponse(cmd, status, extra) {
  return Object.assign({
    schemaVersion: SCHEMA_VERSION,
    requestId: cmd.requestId,
    status: status,
    mode: cmd.mode,
    response: '',
    humanReply: '',
    conversationId: cmd.conversationId,
    turnId: cmd.turnId !== undefined ? cmd.turnId + 1 : undefined,
    error: '',
    polledMs: 0,
    extensionVersion: EXTENSION_VERSION,
    finishedAt: new Date().toISOString(),
  }, extra || {});
}

function legacyResponse(cmd, success, reason, extra) {
  const res = {
    success: success,
    reason: reason,
    request_id: cmd.requestId,
    priority: cmd.priority,
  };
  return Object.assign(res, extra || {});
}

// ---- Main handlers ---------------------------------------------------------
async function handleDiscover(cmd, resPath, legacy) {
  try {
    const models = ADAPTER.hasLmApi() ? await ADAPTER.selectModels() : [];
    const catalog = (models || []).map(m => ({
      name: m.name, vendor: m.vendor, id: m.id,
      family: m.family || undefined,
      version: m.version || undefined,
      maxInputTokens: m.maxInputTokens || undefined,
    }));
    if (legacy) {
      writeReceipt(resPath, legacyResponse(cmd, true, 'discovery', { models: catalog }), cmd.requestId, cmd.message);
    } else {
      writeReceipt(resPath, newResponse(cmd, 'discovery', { models: catalog }), cmd.requestId, cmd.message);
    }
  } catch (err) {
    const detail = String(err);
    if (legacy) {
      writeResult(resPath, legacyResponse(cmd, false, 'discovery_failed', { detail: detail }));
    } else {
      writeResult(resPath, newResponse(cmd, 'discovery_failed', { error: detail }));
    }
  }
}

/** Silent path: vscode.lm direct.  Returns true and writes receipt on success. */
async function sendViaLmApi(cmd, resPath, legacy) {
  const responseTimeoutMs = parseInt(cmd.lmResponseTimeoutMs || DEFAULT_LM_RESPONSE_TIMEOUT_MS, 10);
  try {
    if (!ADAPTER.hasLmApi()) {
      return false;
    }
    let allModels;
    try {
      allModels = await withTimeout(ADAPTER.selectModels(), responseTimeoutMs);
    } catch (err) {
      if (err && err.__timeout) {
        const detail = 'lm_select_models_timeout';
        if (legacy) {
          writeResult(resPath, legacyResponse(cmd, false, 'lm_api_unavailable', { detail: detail }));
        } else {
          writeResult(resPath, newResponse(cmd, 'timeout', { error: detail }));
        }
        return true;
      }
      return false;
    }
    if (!allModels || allModels.length === 0) { return false; }

    // Copilot registers internal "utility" proxies (id/family
    // `copilot-utility*`) that can share a display name with a real
    // third-party model (e.g. "DeepSeek V4 Flash Vision Exp" appears both
    // as vendor=copilot/id=copilot-utility-small and as
    // vendor=deepseek/id=deepseek-v4-flash-vision-exp).  A naive first-name
    // match would pick the proxy (which returns an empty stream), so skip
    // those entries when the caller gave an explicit model name.
    const isUtilityProxy = (m) => {
      const id = String(m.id || '');
      const family = String(m.family || '');
      return id.startsWith('copilot-utility') || family.startsWith('copilot-utility');
    };
    const pickModel = (models, preferred) => {
      if (preferred) {
        // 1) Exact ID match first (caller may pass an id like
        //    `deepseek-v4-flash-vision-exp`).
        const byId = models.find(m =>
          String(m.id || '').toLowerCase() === preferred);
        if (byId) { return byId; }
        // 2) Name match: prefer the first real (non-utility-proxy) entry;
        //    fall back to any name match only if every match is a proxy.
        const byName = models.filter(m =>
          String(m.name || '').toLowerCase() === preferred);
        if (byName.length > 0) {
          const real = byName.find(m => !isUtilityProxy(m));
          if (real) { return real; }
          return byName[0];
        }
      }
      const auto = models.find(m => m.id === 'auto' || m.name === 'Auto');
      if (auto) { return auto; }
      const ds = models.find(m => m.name === 'DeepSeek V4 Flash' || m.id === 'deepseek-v4-flash');
      if (ds) { return ds; }
      return models[0];
    };

    const model = pickModel(allModels, cmd.model);
    const userMessage = vscode.LanguageModelChatMessage.User(cmd.message);
    const requestOptions = {};
    if (cmd.modelOptions && Object.keys(cmd.modelOptions).length > 0) {
      requestOptions.modelOptions = cmd.modelOptions;
    }
    let response;
    try {
      response = await withTimeout(
        ADAPTER.sendLm(model, [userMessage], requestOptions), responseTimeoutMs);
    } catch (err) {
      if (err && err.__timeout) {
        // Provider never answered inside the budget — write an explicit
        // timeout receipt instead of leaving the caller waiting blind.
        const detail = 'lm_send_request_timeout';
        if (legacy) {
          writeResult(resPath, legacyResponse(cmd, false, 'lm_api_unavailable', { detail: detail }));
        } else {
          writeResult(resPath, newResponse(cmd, 'timeout', { error: detail }));
        }
        return true;
      }
      return false;
    }

    const chunks = [];
    const deadline = Date.now() + responseTimeoutMs;
    let truncated = false;
    // Guard the STREAM phase too: some providers leave response.text's
    // iterator pending forever.  With plain `for await`, the deadline check
    // below could never run, so the request would hang with no receipt.
    try {
      const iterator = response.text[Symbol.asyncIterator]();
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const next = await withTimeout(iterator.next(), remaining);
        if (next.done) { break; }
        chunks.push(next.value);
      }
    } catch (err) {
      if (err && err.__timeout) {
        truncated = true;
      }
      // Other stream errors: keep what we already collected.
    }

    const aiResponse = chunks.join('') || null;
    if (legacy) {
      writeReceipt(resPath, legacyResponse(cmd, true, 'sent_via_lm_api', {
        model_name: model.name, model_vendor: model.vendor, model_id: model.id,
        ai_response: aiResponse,
        ai_response_truncated: truncated || undefined,
      }), cmd.requestId, cmd.message);
    } else {
      writeReceipt(resPath, newResponse(cmd, 'ok', {
        response: aiResponse || '',
        modeUsed: 'silent',
        model: { name: model.name, vendor: model.vendor, id: model.id },
        aiResponseTruncated: truncated || undefined,
      }), cmd.requestId, cmd.message);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/** Visible path: chat panel delivery (clipboard + chat commands). */
async function sendViaClipboard(cmd, resPath, legacy) {
  // Save/restore the user's clipboard so this delivery mode does not
  // silently discard whatever they had copied before the send.
  let previousClipboard = null;
  let clipboardSaved = false;
  let clipboardRestored = false;
  const restoreClipboard = async () => {
    if (clipboardSaved && !clipboardRestored) {
      clipboardRestored = true;
      try { await vscode.env.clipboard.writeText(previousClipboard); } catch (_) {}
    }
  };
  try {
    try {
      previousClipboard = await vscode.env.clipboard.readText();
      clipboardSaved = true;
    } catch (_) { /* clipboard read unavailable on this platform — skip restore */ }

    // Clear stale pending queue first — avoids the "保留/移除" dialog.
    await runPanelCommand('removePending');
    if (cmd.priority === 'high') {
      await runPanelCommand('cancel');
    }
    await runPanelCommand('open');

    await vscode.env.clipboard.writeText(cmd.message);
    await runPanelCommand('focusInput');
    await new Promise(r => setTimeout(r, PASTE_DELAY_MS));
    await runPanelCommand('paste');
    // Give the (asynchronous) paste command time to consume the clipboard
    // BEFORE restoring the caller's original content.  Restoring earlier
    // races the paste read and can deliver the user's previous clipboard
    // text to the chat input instead of cmd.message.
    await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));

    if (cmd.priority === 'normal') {
      await runPanelCommand('queueMessage');
    } else {
      await runPanelCommand('submit');
    }

    // The paste/submit no longer read the clipboard — safe to restore now.
    await restoreClipboard();

    // M1: visible receipt returns immediately; humanReply capture is M2 (S0 decides).
    if (legacy) {
      writeReceipt(resPath, legacyResponse(cmd, true, 'sent_via_clipboard_fallback'), cmd.requestId, cmd.message);
    } else {
      writeReceipt(resPath, newResponse(cmd, 'ok', { modeUsed: 'visible' }), cmd.requestId, cmd.message);
    }
  } catch (err) {
    await restoreClipboard();
    if (legacy) {
      writeResult(resPath, legacyResponse(cmd, false, 'clipboard_fallback_failed', { detail: String(err) }));
    } else {
      writeResult(resPath, newResponse(cmd, 'extension_error', { error: String(err) }));
    }
  }
}

function processCommandFile(cmdFile, resFile, isLegacyFile) {
  let raw;
  try {
    raw = fs.readFileSync(cmdFile, 'utf-8');
  } catch (_) {
    return; // file vanished between existsSync and read — benign race, retry next tick
  }

  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch (err) {
    // Malformed payload: quarantine instead of leaving it in place, which
    // would otherwise be re-read and re-fail on every poll tick forever
    // with zero diagnostic signal (silent infinite retry).
    quarantineCommandFile(cmdFile, String(err));
    return;
  }
  try { fs.unlinkSync(cmdFile); } catch (_) {}

  const normalized = normalizeCommand(cmd, isLegacyFile);
  if (!normalized) {
    writeResult(resFile, isLegacyFile
      ? { success: false, reason: 'command_error', detail: 'invalid payload', request_id: '' }
      : newResponse({ requestId: '', mode: 'visible', conversationId: '', turnId: undefined }, 'extension_error', { error: 'invalid payload' }));
    return;
  }

  // Idempotent replay: a retried requestId (same channel file + same message)
  // gets its successful receipt back without re-running the side effect.
  if (replayIfCached(normalized.requestId, resFile, normalized.message)) {
    return;
  }

  if (normalized.isDiscover) {
    if (isBusy(resFile)) {
      writeResult(resFile, normalized.legacy
        ? legacyResponse(normalized, false, 'busy')
        : newResponse(normalized, 'busy', { error: 'busy: another request is in flight for this response channel' }));
      return;
    }
    markBusy(resFile);
    setImmediate(async () => {
      try {
        await handleDiscover(normalized, resFile, normalized.legacy);
      } finally {
        clearBusy(resFile);
      }
    });
    return;
  }

  if (!normalized.message) {
    writeResult(resFile, normalized.legacy
      ? legacyResponse(normalized, false, 'no_message')
      : newResponse(normalized, 'no_message', { error: 'no_message' }));
    return;
  }

  if (isBusy(resFile)) {
    writeResult(resFile, normalized.legacy
      ? legacyResponse(normalized, false, 'busy')
      : newResponse(normalized, 'busy', { error: 'busy: another request is in flight for this response channel' }));
    return;
  }
  markBusy(resFile);
  setImmediate(async () => {
    try {
      if (normalized.mode === 'visible') {
        await sendViaClipboard(normalized, resFile, normalized.legacy);
        return;
      }
      const ok = await sendViaLmApi(normalized, resFile, normalized.legacy);
      if (ok) { return; }
      if (normalized.mode === 'silent') {
        writeResult(resFile, normalized.legacy
          ? legacyResponse(normalized, false, 'lm_api_unavailable')
          : newResponse(normalized, 'lm_api_unavailable', { error: 'lm_api_unavailable' }));
        return;
      }
      // auto → fall back to visible
      await sendViaClipboard(normalized, resFile, normalized.legacy);
    } catch (err) {
      writeResult(resFile, normalized.legacy
        ? legacyResponse(normalized, false, 'command_error', { detail: String(err) })
        : newResponse(normalized, 'extension_error', { error: String(err) }));
    } finally {
      clearBusy(resFile);
    }
  });
}

// ---- Corrupt command file quarantine (F2) ---------------------------------
function quarantineCommandFile(cmdFile, detail) {
  const quarantined = cmdFile + '.bad-' + process.pid + '-' + Date.now();
  try {
    fs.renameSync(cmdFile, quarantined);
  } catch (_) {
    try { fs.unlinkSync(cmdFile); } catch (_) {}
  }
  writeResult(newDiagFile(MY_WINDOW_PID), {
    schemaVersion: SCHEMA_VERSION,
    reason: 'invalid_command_payload',
    pid: MY_WINDOW_PID,
    file: cmdFile,
    quarantinedTo: quarantined,
    detail: detail,
    at: new Date().toISOString(),
    extensionVersion: EXTENSION_VERSION,
  });
}

function tryProcessCommand() {
  // 1. New protocol, PID-scoped (instance routing, preferred).
  const newCmd = newCmdFile(MY_WINDOW_PID);
  if (fs.existsSync(newCmd)) {
    processCommandFile(newCmd, newResFile(MY_WINDOW_PID), false);
    return;
  }
  // 2. Legacy PID-scoped (whois instance routing).
  const legacyPidCmd = legacyCmdForPid(MY_WINDOW_PID);
  if (fs.existsSync(legacyPidCmd)) {
    processCommandFile(legacyPidCmd, legacyResForPid(MY_WINDOW_PID), true);
    return;
  }
  // 3. Legacy shared (backward compatible fallback).
  if (fs.existsSync(LEGACY_CMD_SHARED)) {
    processCommandFile(LEGACY_CMD_SHARED, LEGACY_RES_SHARED, true);
  }
}

// ---- Stale file cleanup (RFC §4.4) ----------------------------------------
function cleanupStaleFiles() {
  const now = Date.now();
  let removed = 0;
  const targets = [];
  try {
    for (const name of fs.readdirSync(channelDir)) {
      targets.push(path.join(channelDir, name));
    }
  } catch (_) {}
  targets.push(LEGACY_CMD_SHARED, LEGACY_RES_SHARED);
  try {
    for (const f of targets) {
      try {
        const st = fs.statSync(f);
        if (now - st.mtimeMs > STALE_FILE_MS) {
          fs.unlinkSync(f);
          removed++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (removed > 0) {
    writeResult(newDiagFile(MY_WINDOW_PID), {
      reason: 'stale_cleanup', pid: MY_WINDOW_PID, removed: removed,
      at: new Date().toISOString(), extensionVersion: EXTENSION_VERSION,
    });
  }
}

// ---- Capability probe (S0) -------------------------------------------------
function probeChatApi() {
  const probe = {
    schemaVersion: SCHEMA_VERSION,
    reason: 'extension_activated',
    pid: MY_WINDOW_PID,
    channelDir: channelDir,
    extensionVersion: EXTENSION_VERSION,
    vscodeVersion: typeof vscode.version !== 'undefined' ? vscode.version : 'unknown',
    appName: undefined,
    appHost: undefined,
    uriScheme: undefined,
    hasChatNamespace: typeof vscode.chat !== 'undefined',
    chatKeys: vscode.chat ? Object.keys(vscode.chat) : undefined,
    hasChatSendRequest: typeof vscode.chat !== 'undefined' && typeof vscode.chat.sendRequest === 'function',
    hasCreateChatParticipant: typeof vscode.chat !== 'undefined' && typeof vscode.chat.createChatParticipant === 'function',
    hasRequestHandler: typeof vscode.chat !== 'undefined' && typeof vscode.chat.requestHandler !== 'undefined',
    hasLmNamespace: typeof vscode.lm !== 'undefined',
    lmKeys: vscode.lm ? Object.keys(vscode.lm) : undefined,
    hasSelectChatModels: typeof vscode.lm !== 'undefined' && typeof vscode.lm.selectChatModels === 'function',
    sessionId: vscode.env.sessionId ? 'has_session' : 'no_session',
  };
  try { probe.appName = vscode.env.appName; } catch (_) {}
  try { probe.appHost = vscode.env.appHost; } catch (_) {}
  try { probe.uriScheme = vscode.env.uriScheme; } catch (_) {}
  writeResult(newDiagFile(MY_WINDOW_PID), probe);

  // Async probe: model availability (for capability matrix / discovery).
  (async () => {
    const lmProbe = {
      schemaVersion: SCHEMA_VERSION,
      reason: 'lm_probe',
      pid: MY_WINDOW_PID,
      at: new Date().toISOString(),
    };
    try {
      if (typeof vscode.lm !== 'undefined' && typeof vscode.lm.selectChatModels === 'function') {
        const models = await vscode.lm.selectChatModels({});
        lmProbe.modelCount = models ? models.length : 0;
        if (models && models.length > 0) {
          lmProbe.modelNames = models.map(m => ({ name: m.name, vendor: m.vendor, id: m.id }));
        }
        const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        lmProbe.copilotCount = copilotModels ? copilotModels.length : 0;
      } else {
        lmProbe.error = 'selectChatModels not available';
      }
    } catch (err) {
      lmProbe.error = String(err);
      lmProbe.errorCode = err.code;
      lmProbe.errorCause = err.cause ? String(err.cause) : undefined;
    }
    writeResult(newDiagFile(MY_WINDOW_PID + '-lm'), lmProbe);
  })();
}

// ---- Activation ------------------------------------------------------------
let pollTimer = null;
let cleanupTimer = null;

function activate(context) {
  probeChatApi();

  tryProcessCommand();
  pollTimer = setInterval(tryProcessCommand, POLL_MS);
  cleanupTimer = setInterval(cleanupStaleFiles, CLEANUP_INTERVAL_MS);

  context.subscriptions.push({
    dispose: function () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
    }
  });
}

function deactivate() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}

exports.activate = activate;
exports.deactivate = deactivate;
