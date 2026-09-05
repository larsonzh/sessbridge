// Unit tests for the extension's silent-conversation-history engine (RFC §5.1).
//
// The extension module requires the VS Code API, which is unavailable in a
// plain Node process.  We load the REAL extension/extension.js source, swap
// the `vscode` require for a minimal stub, then exercise the pure history
// functions (token estimates, head/tail folding, code-fence sealing, anchor
// protection, eviction, retry dedup, turn numbering, stats, message assembly).
//
// Run:  node tests/test_history_engine.js   (exit 0 = pass, 1 = fail)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const EXT_SRC = path.join(ROOT, 'extension', 'extension.js');

let src = fs.readFileSync(EXT_SRC, 'utf8');
src = src.replace(
  "const vscode = require('vscode');",
  "const vscode = { LanguageModelChatMessage: { " +
  "User: (content) => ({ __role: 'user', content: content }), " +
  "Assistant: (content) => ({ __role: 'assistant', content: content }) } };"
);
src += '\nmodule.exports = { estimateTokens, foldLongText, compressAssistantText, ' +
  'commitHistoryTurn, applyHistoryCaps, historyStatsOf, buildLmMessages, ' +
  'loadHistory, saveHistory, deleteHistory, newHistory, sanitizeConversationId, ' +
  'historyFilePath, historyArchivePath, anchorEndIndex, estimateMessagesBytes };';

const sandbox = {
  require: require,
  module: { exports: {} },
  exports: {},
  process: process,
  Buffer: Buffer,
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setImmediate: setImmediate,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const H = sandbox.module.exports;

let checks = 0;
let failures = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    failures += 1;
    console.error('FAIL - ' + name + ' :: ' + (err && err.message ? err.message : err));
  }
}

// 1) sanitize + path safety
check('sanitizeConversationId keeps safe ids', () => {
  if (H.sanitizeConversationId('conv-audit-001') !== 'conv-audit-001') throw new Error('safe id altered');
  const evil = H.sanitizeConversationId('a/../b\\c');
  if (evil.includes('/') || evil.includes('\\')) throw new Error('path chars not sanitized');
  if (!H.historyFilePath('conv-x').includes('history_conv-x.json')) throw new Error('unexpected path');
});

// 2) token estimate (chars/4 conservative)
check('estimateTokens chars/4', () => {
  if (H.estimateTokens('abcd') !== 1) throw new Error('4 chars should map to 1 token');
  if (H.estimateTokens('abcdefgh') !== 2) throw new Error('8 chars should map to 2 tokens');
});

// 3) fold + code-fence sealing
check('assistant compression folds and seals fences', () => {
  const long = 'x'.repeat(5000) + '\n```json\n{"a":1}';
  const folded = H.compressAssistantText(long);
  if (!(folded.length < long.length)) throw new Error('not compressed');
  if (((folded.match(/```/g) || []).length) % 2 !== 0) throw new Error('fence not sealed');
  if (!folded.includes('...[truncated]...')) throw new Error('marker missing');
});

// 4) default compress on; noCompress keeps full text
check('default compression folds long assistant output', () => {
  let h = H.newHistory('conv-v');
  H.commitHistoryTurn(h, { requestId: 'r1', message: 'brief', turnId: 0 }, 'y'.repeat(3000), 'conv-v');
  if (h.messages[1].content.length !== 719) throw new Error('expected 200+marker+500 fold');
});
check('noCompress keeps full assistant output', () => {
  let h = H.newHistory('conv-v');
  H.commitHistoryTurn(h, { requestId: 'r1', message: 'brief', turnId: 0, noCompress: true }, 'y'.repeat(3000), 'conv-v');
  if (h.messages[1].content.length !== 3000) throw new Error('noCompress was ignored');
});

// 5) anchor brief fold + roles
check('over-long anchor brief is folded before storage', () => {
  const h = H.newHistory('conv-a');
  H.commitHistoryTurn(h, { requestId: 'r0', message: 'Z'.repeat(20000), turnId: 0 }, 'ok', 'conv-a');
  if (!h.messages[0].content.includes('...[brief condensed]...')) throw new Error('anchor not folded');
  if (h.messages[0].role !== 'user' || h.messages[1].role !== 'assistant') throw new Error('roles wrong');
});

// 6) turn numbering: turnId 0 -> turn 1 (matches golden receipt turnId=1)
check('turn numbering matches golden (turnId 0 -> 1)', () => {
  const h = H.newHistory('conv-t');
  H.commitHistoryTurn(h, { requestId: 'rt', message: 'm', turnId: 0 }, 'a', 'conv-t');
  if (h.turnId !== 1 || h.messages[0].turnId !== 1 || h.messages[1].turnId !== 1) {
    throw new Error('turn numbers wrong');
  }
});

// 7) retry dedup
check('duplicate requestId never re-appended', () => {
  const h = H.newHistory('conv-d');
  H.commitHistoryTurn(h, { requestId: 'r0', message: 'm', turnId: 0 }, 'a', 'conv-d');
  const before = h.messages.length;
  H.commitHistoryTurn(h, { requestId: 'r0', message: 'dup', turnId: 1 }, 'again', 'conv-d');
  if (h.messages.length !== before) throw new Error('duplicate turn appended');
});

// 8) caps: eviction protects anchor pair, records stats
check('eviction protects anchor and records truncation', () => {
  const h = H.newHistory('conv-cap');
  H.commitHistoryTurn(h, { requestId: 'r1', message: 'anchor brief', turnId: 0 }, 'a1', 'conv-cap');
  for (let i = 1; i < 12; i++) {
    H.commitHistoryTurn(h, { requestId: 'r' + i, message: 'm' + i }, 'a' + i, 'conv-cap');
  }
  if (h.messages.length > 20) throw new Error('turn cap not respected');
  if (h.messages.length < 2) throw new Error('anchor pair lost');
  if (h.messages[0].role !== 'user' || h.messages[1].role !== 'assistant') {
    throw new Error('anchor pair not preserved');
  }
  if (!(h.truncated.evictedTurns > 0) || !h.truncated.isTruncated) {
    throw new Error('eviction not recorded');
  }
});

// 9) stats shape
check('historyStats exposes health metrics', () => {
  const h = H.newHistory('conv-s');
  H.commitHistoryTurn(h, { requestId: 'r1', message: 'm', turnId: 0 }, 'a', 'conv-s');
  const s = H.historyStatsOf(h);
  ['totalTurns', 'inputTokensEst', 'isTruncated', 'evictedTurns'].forEach((k) => {
    if (!(k in s)) throw new Error('missing ' + k);
  });
  if (s.totalTurns < 1) throw new Error('totalTurns wrong');
});

// 10) message assembly
check('buildLmMessages history + current user message', () => {
  const h = H.newHistory('conv-m');
  H.commitHistoryTurn(h, { requestId: 'r1', message: 'm', turnId: 0 }, 'a', 'conv-m');
  const msgs = H.buildLmMessages(h, { message: 'next' });
  if (msgs.length !== h.messages.length + 1) throw new Error('length mismatch');
  const last = msgs[msgs.length - 1];
  if (last.__role !== 'user' || last.content !== 'next') throw new Error('last message wrong');
});

// 11) load/save roundtrip
check('history load/save roundtrip', () => {
  const cid = 'roundtrip-1';
  const h1 = H.newHistory(cid);
  H.commitHistoryTurn(h1, { requestId: 'rr', message: 'hello', turnId: 0 }, 'world', cid);
  fs.writeFileSync(H.historyFilePath(cid), JSON.stringify(h1));
  const h2 = H.loadHistory(cid);
  if (h2.messages.length !== h1.messages.length) throw new Error('roundtrip length mismatch');
  if (h2.messages[0].content !== 'hello') throw new Error('roundtrip content mismatch');
  H.deleteHistory(cid);
});

console.log('---');
console.log('history engine unit tests: ' + checks + ' run, ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);
