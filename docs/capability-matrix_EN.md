# SessionBridge Capability Matrix

> 简体中文：[capability-matrix.md](capability-matrix.md)

> Status: **S0 completed** (2026-09-04; probes `diag_28012.json` / `diag_28012-lm.json`;
> extension 0.1.0).

## 1. Environment

| Item | Value |
|---|---|
| Test date | 2026-09-04 |
| VS Code version | 1.136.1 (x64; commit a44adf7f53e0) |
| Copilot extension version | Provided via `vscode.lm`/`vscode.chat` (extension ID not explicitly listed in `--list-extensions`; LM providers presented via `copilot`/`deepseek` vendor) |
| LM channels / models | 34 models (vendor `copilot` 31 + vendor `deepseek` 3): incl. Auto, GPT-5.4/5.5/5.6, Claude Opus/Sonnet 5, Gemini 3.x, Grok 4.x, Kimi, MAI-Code, **DeepSeek V4 Flash / V4 Pro / V4 Flash Vision Exp** |
| OS | Windows |
| Related extensions installed | `larsonzh.sessbridge` (this S0), `larsonzh.vscode-chat-sender` (legacy; uninstall before production use) |

## 2. API availability (probe results)

| API | Available | Notes |
|---|---|---|
| `vscode.chat` namespace | ✅ | `chatKeys` total 35 (participants / session items / custom agents / hooks, etc.) |
| `vscode.chat.sendRequest` | ❌ | Does not exist |
| `vscode.chat.createChatParticipant` | ✅ | M2 human-reply **controlled channel** depends on this |
| `vscode.chat.requestHandler` | ❌ | Does not exist (old API removed) — full capture not feasible |
| `vscode.lm.selectChatModels` | ✅ | `modelCount=34` |
| `vscode.lm` model list (count / names) | ✅ | 34 (incl. DeepSeek V4 Flash → silent default model hit) |

## 3. Mode capability conclusions (S0 frozen; end-to-end tested 2026-09-04)

| Mode | Delivery | Capture AI response | Capture human reply | Conclusion |
|---|---|---|---|---|
| `visible` | ✅ visible in panel (clipboard + panel commands) | — (chat panel) | ⚠️ limited (see below) | **Delivery works; human replies go through the controlled channel** |
| `silent` | ✅ zero UI | ✅ `response` (LM API direct) | — | **✅ End-to-end PASS** (`Auto`/copilot model: status=ok, modeUsed=silent, full response) |
| `auto` | ✅ silent→visible fallback | ✅ depends on path | ⚠️ same as visible | **Usable** |

**Silent end-to-end test (2026-09-04, VS Code 1.136.1, extension 0.1.0)**:
- ✅ `Auto` (vendor `copilot`): `sendRequest` returned normally, receipt `status:ok` +
  `modeUsed:silent` + full `response`; the whole path is usable.
- ✅ `DeepSeek V4 Flash` (vendor `deepseek`, via `vizards.deepseek-v4-for-copilot` channel):
  after reload the test returned `S0-OK`, receipt `status:ok` + `modeUsed:silent`,
  requestId `s0-deepseek-4`, target PID `28012`.
- **Runtime protection**: `sendViaLmApi` now has timeouts for model enumeration,
  `sendRequest`, and stream collection, sharing the `lmResponseTimeoutMs` budget;
  if a provider hangs again, an explicit receipt is written (new protocol
  `status:"timeout"` / legacy `reason:"lm_api_unavailable"` + detail) instead of
  leaving the caller waiting blind.

**M2 human-reply capture conclusion (2026-09-04)**:
- `requestHandler` unavailable and `sendRequest` is not a `vscode.chat` API →
  **full silent capture** of chat replies is not feasible; not adopted (and must not
  degrade to GUI automation).
- `createChatParticipant` available → M2 uses a **controlled reply channel**: register
  the `sessbridge.review` participant; a human triggers it with `@sessbridge.review <reply>`,
  and the participant handler writes the reply into `res_<pid>.json` under `humanReply`
  (the "controlled receipt-file supplement" fallback permitted by RFC §5).

**§5.1 Silent conversation history end-to-end test (2026-09-05, VS Code 1.136.1,
  extension 0.1.0, `Auto`/copilot model)**:
- Session `s0-smoke-001` passed all three turns: ① injected marker `SESS-SMOKE-42`
  (turnId 0); ② asked "what was the marker?" → replied `SESS-SMOKE-42` (turn 2
  referenced the turn-1 fact); ③ `--reset-history` then injected `PHASE-2-OK` →
  history reset (`totalTurns` back to 1).
- Receipt `history` health metrics correct: turn1 `{totalTurns:1, inputTokensEst:17}`,
  turn2 `{totalTurns:2, inputTokensEst:27}`, after reset `{totalTurns:1}`;
  `isTruncated:false`.
- Disk persistence: `history_s0-smoke-001.json` shape correct (`schemaVersion=1`,
  messages carry `role/requestId/turnId/createdAt`); after reset the file returned
  to `turnId=1 / 2 messages`.
- **Conclusion: §5.1 silent conversation history end-to-end ✅ PASS** (multi-turn
  context, health-metric echo, and explicit reset all match the RFC and golden samples).

## 4. Degradation route (confirmed)

- Keep the "delivery + poll receipt" one-way semantics (M1 status quo): `visible`
  delivery returns an immediate receipt, `humanReply` empty.
- Human replies are supplemented via the **controlled participant channel**
  (`humanReply` field), written by a human using `@sessbridge.review`; recorded in
  RFC §5 open question 1.
- No GUI automation (AHK / keyboard simulation / clipboard injection / window focus control).
- **DeepSeek channel**: this S0 silent direct call PASSed; the explicit timeout receipt
  and the `auto` mode (silent failure → visible fallback) are kept as the fallback
  when the provider behaves abnormally.
