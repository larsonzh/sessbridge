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
    registerReviewParticipant: (handler) => {
      if (typeof vscode.chat !== 'undefined' &&
          typeof vscode.chat.createChatParticipant === 'function') {
        try {
          // Namespaced participant id; triggered in the panel as
          // `@sessbridge.review <conversationId> <reply>` (RFC §5.2).
          return vscode.chat.createChatParticipant('sessbridge.review', handler);
        } catch (_) { return null; }
      }
      return null;
    },
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

// ---- Silent conversation history (RFC §5.1) -------------------------------
// The history engine is active ONLY for the new protocol + a non-empty
// conversationId.  Empty conversationId keeps the stateless legacy behavior:
// no history files are read or written (prevents cross-request crosstalk).
const HISTORY_MAX_TURNS = parseInt(process.env.SESSBRIDGE_HISTORY_MAX_TURNS, 10) || 20;
const HISTORY_MAX_TOKENS = parseInt(process.env.SESSBRIDGE_HISTORY_MAX_TOKENS, 10) || 24000;
const HISTORY_MAX_FILE_BYTES = 1 * 1024 * 1024; // 1MB per history file
const HISTORY_ANCHOR_MAX_TOKENS = parseInt(
  process.env.SESSBRIDGE_HISTORY_ANCHOR_MAX_TOKENS, 10) || 4000;
const HISTORY_COMPRESS_ASSISTANT =
  (process.env.SESSBRIDGE_HISTORY_COMPRESS_ASSISTANT || '1') !== '0';
// Model-based middle compaction (one extra LM call) is reserved; this
// increment keeps deterministic head/tail folding in both modes.
const HISTORY_SUMMARIZE = (process.env.SESSBRIDGE_HISTORY_SUMMARIZE || '0') === '1';
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // main + archive (RFC §5.1)
const HISTORY_ASSISTANT_COMPRESS_CHARS = 2000;
const HISTORY_ASSISTANT_HEAD = 200;
const HISTORY_ASSISTANT_TAIL = 500;

function sanitizeConversationId(cid) {
  const raw = String(cid || '');
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  if (safe !== raw) {
    // Path-unsafe ids get a deterministic suffix so two distinct ids
    // can never collide on the same file.
    let h = 0;
    for (let i = 0; i < raw.length; i++) { h = ((h << 5) - h + raw.charCodeAt(i)) | 0; }
    return safe + '-' + (h >>> 0).toString(16);
  }
  return safe;
}

function historyFilePath(cid) {
  return path.join(channelDir, 'history_' + sanitizeConversationId(cid) + '.json');
}

function historyArchivePath(cid) {
  return path.join(channelDir, 'history_' + sanitizeConversationId(cid) + '.archive.json');
}

function replyFilePath(cid) {
  return path.join(channelDir, 'reply_' + sanitizeConversationId(cid) + '.json');
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4); // conservative chars/4
}

// Deterministic head/tail fold (no extra LM call).
function foldLongText(text, head, tail, marker) {
  const s = String(text || '');
  if (s.length <= head + tail) { return s; }
  return s.slice(0, head) + marker + s.slice(-tail);
}

// Re-seal an unclosed ``` fence so a truncated assistant message can never
// leave the model with dangling markdown (syntax-hallucination guard).
function sealCodeFences(text) {
  let s = String(text || '');
  const fences = (s.match(/```/g) || []).length;
  if (fences % 2 === 1) { s = s + '\n```'; }
  return s;
}

function compressAssistantText(text) {
  let s = String(text || '');
  if (s.length > HISTORY_ASSISTANT_COMPRESS_CHARS) {
    s = foldLongText(s, HISTORY_ASSISTANT_HEAD, HISTORY_ASSISTANT_TAIL,
      '\n...[truncated]...\n');
    s = sealCodeFences(s);
  }
  return s;
}

function newHistory(cid) {
  return {
    schemaVersion: SCHEMA_VERSION,
    conversationId: cid,
    turnId: 0,
    updatedAt: new Date().toISOString(),
    messages: [],
    truncated: { isTruncated: false, evictedTurns: 0, evictedChars: 0 },
  };
}

function loadHistory(cid) {
  const f = historyFilePath(cid);
  try {
    if (!fs.existsSync(f)) { return newHistory(cid); }
    const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) {
      return newHistory(cid);
    }
    return data;
  } catch (_) {
    return newHistory(cid);
  }
}

function saveHistory(cid, hist) {
  hist.updatedAt = new Date().toISOString();
  writeResult(historyFilePath(cid), hist);
}

function deleteHistory(cid) {
  try { fs.unlinkSync(historyFilePath(cid)); } catch (_) {}
  try { fs.unlinkSync(historyArchivePath(cid)); } catch (_) {}
}

// ---- Controlled human-reply channel (RFC §5.2) -----------------------------
// Human review goes through a chat participant: `@sessbridge.review
// <conversationId> <reply>` in the panel.  The handler validates the
// conversation id (fail-close) and writes `reply_<conversationId>.json`
// (runtime file: UTF-8 without BOM + LF, atomic write).
function writeHumanReply(cid, replyText) {
  const cidRaw = String(cid || '').trim();
  if (!cidRaw) {
    throw new Error('missing conversationId — usage: @sessbridge.review <conversationId> <reply>');
  }
  let hist = null;
  try { hist = loadHistory(cidRaw); } catch (_) {}
  const data = {
    schemaVersion: SCHEMA_VERSION,
    conversationId: cidRaw,
    turnId: (hist && Number(hist.turnId)) || 1,
    humanReply: String(replyText || ''),
    requestId: '',
    reviewedAt: new Date().toISOString(),
    extensionVersion: EXTENSION_VERSION,
  };
  writeResult(replyFilePath(cidRaw), data);
  return data;
}

async function handleReviewPrompt(request, _context, stream, _token) {
  const prompt = String((request && request.prompt) || '').trim();
  const respond = (text) => {
    try {
      if (stream && typeof stream.markdown === 'function') {
        stream.markdown(text);
      } else if (request && typeof request.reply === 'function') {
        request.reply(text);
      }
    } catch (_) {}
  };
  const m = prompt.match(/^(\S+)\s+([\s\S]*)$/);
  if (!m) {
    respond('用法：@sessbridge.review <conversationId> <回复内容>（缺少会话 ID，未写入回复）');
    return;
  }
  const cid = m[1].trim();
  const replyText = m[2].trim();
  if (!replyText) {
    respond('回复内容为空，未写入回复文件。');
    return;
  }
  try {
    const data = writeHumanReply(cid, replyText);
    respond('已记录人工回复 → ' + path.basename(replyFilePath(cid)) +
      '（conversationId=' + data.conversationId + '）');
  } catch (err) {
    respond('写入人工回复失败：' + String(err));
  }
}

function appendArchive(cid, evicted) {
  if (!evicted || evicted.length === 0) { return; }
  let archive = [];
  const f = historyArchivePath(cid);
  try {
    if (fs.existsSync(f)) { archive = JSON.parse(fs.readFileSync(f, 'utf-8')); }
  } catch (_) {}
  if (!Array.isArray(archive)) { archive = []; }
  writeResult(f, archive.concat(evicted));
}

// Head + tail eviction: protect the anchor (first user message + its
// assistant reply), then drop oldest non-anchor messages until the
// turn/token/size budgets are met.  Eviction is recorded in hist.truncated
// and archived (never silently lost).
function anchorEndIndex(hist) {
  const msgs = hist.messages || [];
  if (msgs.length >= 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant') {
    return 2;
  }
  return msgs.length >= 1 ? 1 : 0;
}

function estimateMessagesBytes(msgs) {
  try { return Buffer.byteLength(JSON.stringify(msgs), 'utf-8'); } catch (_) { return 0; }
}

function applyHistoryCaps(hist) {
  if (!hist || !Array.isArray(hist.messages)) { return hist; }
  const msgs = hist.messages;
  const anchorEnd = anchorEndIndex(hist);
  let totalTokens = 0;
  for (const m of msgs) { totalTokens += estimateTokens(m.content); }
  const overBudget = () =>
    msgs.length > HISTORY_MAX_TURNS ||
    totalTokens > HISTORY_MAX_TOKENS ||
    estimateMessagesBytes(msgs) > HISTORY_MAX_FILE_BYTES;
  const evicted = [];
  while (msgs.length > anchorEnd && overBudget()) {
    const removed = msgs.splice(anchorEnd, 1)[0];
    if (removed) {
      evicted.push(removed);
      totalTokens -= estimateTokens(removed.content);
    }
  }
  if (evicted.length > 0) {
    hist.truncated = hist.truncated ||
      { isTruncated: false, evictedTurns: 0, evictedChars: 0 };
    hist.truncated.isTruncated = true;
    hist.truncated.evictedTurns += evicted.length;
    let chars = 0;
    for (const e of evicted) { chars += String(e.content || '').length; }
    hist.truncated.evictedChars += chars;
    appendArchive(hist.conversationId, evicted);
  }
  return hist;
}

function historyStatsOf(hist) {
  if (!hist) { return undefined; }
  let tokens = 0;
  for (const m of (hist.messages || [])) { tokens += estimateTokens(m.content); }
  return {
    totalTurns: Number(hist.turnId) || 0,
    inputTokensEst: tokens,
    isTruncated: !!(hist.truncated && hist.truncated.isTruncated),
    evictedTurns: (hist.truncated && hist.truncated.evictedTurns) || 0,
  };
}

// Assemble the full messages array: history (user/assistant pairs) + the
// current user message.
function buildLmMessages(hist, cmd) {
  const msgs = [];
  for (const m of (hist.messages || [])) {
    if (m.role === 'assistant') {
      msgs.push(vscode.LanguageModelChatMessage.Assistant(m.content));
    } else {
      msgs.push(vscode.LanguageModelChatMessage.User(m.content));
    }
  }
  msgs.push(vscode.LanguageModelChatMessage.User(cmd.message));
  return msgs;
}

// Atomic commit (RFC §5.1): append this turn ONLY on a successful response.
// Idempotency: a requestId already present is never re-appended (retry dedup).
function commitHistoryTurn(hist, cmd, assistantText, cid) {
  if (!hist) { return; }
  const already = hist.messages.some(m => m.requestId === cmd.requestId);
  if (already) { return; }
  const turnNo = cmd.turnId !== undefined ? cmd.turnId + 1
    : (Number(hist.turnId) || 0) + 1;
  let userContent = cmd.message;
  // Anchor self-defense: an over-long task brief is folded before storage
  // so dynamic turns always keep >= 60% of the budget.
  if (hist.messages.length === 0 &&
      estimateTokens(userContent) > HISTORY_ANCHOR_MAX_TOKENS) {
    userContent = foldLongText(userContent, HISTORY_ANCHOR_MAX_TOKENS * 2,
      HISTORY_ANCHOR_MAX_TOKENS, '\n...[brief condensed]...\n');
  }
  let assistantContent = String(assistantText || '');
  if (HISTORY_COMPRESS_ASSISTANT && !cmd.noCompress) {
    assistantContent = compressAssistantText(assistantContent);
  }
  hist.messages.push({
    role: 'user', content: userContent, requestId: cmd.requestId,
    turnId: turnNo, createdAt: new Date().toISOString(),
  });
  hist.messages.push({
    role: 'assistant', content: assistantContent, requestId: cmd.requestId,
    turnId: turnNo, createdAt: new Date().toISOString(),
  });
  hist.turnId = turnNo;
  applyHistoryCaps(hist);
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
    resetHistory: raw.resetHistory === true,
    noCompress: raw.noCompress === true,
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
    // RFC §5.1: history engine active only for new protocol + non-empty
    // conversationId; empty keeps the stateless single-shot behavior.
    const historyActive = !legacy && !!cmd.conversationId &&
      String(cmd.conversationId).trim().length > 0;
    let hist = null;
    if (historyActive) {
      if (cmd.resetHistory) { deleteHistory(cmd.conversationId); }
      hist = loadHistory(cmd.conversationId);
    }
    let messages;
    if (historyActive && hist) {
      messages = buildLmMessages(hist, cmd);
    } else {
      messages = [vscode.LanguageModelChatMessage.User(cmd.message)];
    }
    const requestOptions = {};
    if (cmd.modelOptions && Object.keys(cmd.modelOptions).length > 0) {
      requestOptions.modelOptions = cmd.modelOptions;
    }
    let response;
    try {
      response = await withTimeout(
        ADAPTER.sendLm(model, messages, requestOptions), responseTimeoutMs);
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
      const okExtra = {
        response: aiResponse || '',
        modeUsed: 'silent',
        model: { name: model.name, vendor: model.vendor, id: model.id },
        aiResponseTruncated: truncated || undefined,
      };
      if (historyActive && hist) {
        // Atomic commit only on success; failed turns are never committed.
        commitHistoryTurn(hist, cmd, aiResponse || '', cmd.conversationId);
        saveHistory(cmd.conversationId, hist);
        okExtra.history = historyStatsOf(hist);
      }
      writeReceipt(resPath, newResponse(cmd, 'ok', okExtra), cmd.requestId, cmd.message);
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
        // History files (history_*.json / .archive.json) follow the RFC §5.1
        // 7-day retention; everything else keeps the 24h contract.
        const isHistory = path.basename(f).indexOf('history_') === 0;
        const retentionMs = isHistory ? HISTORY_RETENTION_MS : STALE_FILE_MS;
        if (now - st.mtimeMs > retentionMs) {
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
    historyConfig: {
      maxTurns: HISTORY_MAX_TURNS,
      maxTokens: HISTORY_MAX_TOKENS,
      maxFileBytes: HISTORY_MAX_FILE_BYTES,
      anchorMaxTokens: HISTORY_ANCHOR_MAX_TOKENS,
      compressAssistant: HISTORY_COMPRESS_ASSISTANT,
      summarize: HISTORY_SUMMARIZE,
    },
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

  // RFC §5.2: controlled human-reply channel via chat participant.
  try {
    const participant = ADAPTER.registerReviewParticipant(handleReviewPrompt);
    if (participant) {
      context.subscriptions.push(participant);
    }
  } catch (_) {}

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
