# RFC: SessionBridge Channel Protocol v1

> 中文版：[RFC-sessbridge-channel-protocol-v1.md](RFC-sessbridge-channel-protocol-v1.md)
>
> Status: Draft (v1.0.0, 2026-09-04). This document defines the SessionBridge channel
> protocol I: the local file/IPC contract for **session-level two-way** interaction
> between VS Code Copilot Chat and external automation.
>
> Origin and inheritance: derived from the whois project's `tools/test/` IPC Chat Sender
> (`vscode-chat-sender` extension, `Send-IpcChatMessage.ps1`, `ipc_chat_sender.py`,
> `install_ipc_chat_extension.ps1`, and `docs/IPC_CHAT_SENDER_README.md`). The whois-side
> old implementation stays unchanged so its A/B unattended flows continue uninterrupted;
> this protocol provides a "legacy protocol compatibility mode" for seamless adoption.

## 1. Purpose and non-goals

### 1.1 Purpose

- Define a **session-level two-way**, receipt-capable, idempotent, auditable local channel:
  external scripts (PowerShell / Python / ProofRail, etc.) deliver messages to VS Code
  Copilot Chat and can **capture human/AI replies**.
- Support three modes: `visible` (visible in the chat panel, two-way, full context),
  `silent` (LM API direct, zero UI, captures AI responses), `auto` (silent first, then visible).
- Support multi VS Code instance routing (by target instance PID).
- Provide a legacy protocol compatibility mode so existing whois flows can adopt this
  product without modification.
- Cross-platform clients: Python 3 (primary), PowerShell (Windows compat layer),
  sh (POSIX).

### 1.2 Non-goals

- No chat UI / standalone chat system (hosted by VS Code Copilot Chat).
- No GUI-automation fallback (AHK, keyboard simulation, clipboard injection, window focus control).
- No ProofRail task/ticket/gate semantics; ProofRail integrates only through this
  protocol's `silent` message layer and file queue (see §7 boundary).
- No cross-host/remote channel promises (first version is local single-user; remote and
  signing are later RFCs).

## 2. Naming and naming record (RFC convention)

| Level | Adopted | Note |
|---|---|---|
| Official name | **SessionBridge** | session-level two-way; avoids the ChatBridge trademark/name collision |
| Engineering/repo name | `sessbridge` | all lowercase, no hyphen |
| Chinese name | **会话桥** | — |
| Internal abbreviation (recommended) | `sess` or `sbr` | **never `sb`** (unpleasant association in Chinese internet context) |

Name availability check (2026-09-04, GitHub API / npm / public search):

- **ChatBridge / `chatbridge` unavailable**: USPTO registered trademark CHATBRIDGE
  (ARI Network Services, Inc., reg. no. 88962890, covering instant-messaging/customer-care
  SaaS categories); commercial product ChatBridge AI (chatbridgeapp.com); GitHub projects
  `ylexLiao/chatbridge` (cross-Copilot/Codex/Claude chat-history bridging) and
  `HARIOM8859/ChatBridge-Extension`; Chrome Web Store extension of the same name.
- **DialogBridge / `dialogbridge` available** (GitHub user/org 404, repo search only hits
  `EricDahlvang/DialogBridgePlayground` — archived 2019, no conflict; npm 404), but the
  name is long; **DlgBridge / `dlgbridge`** also available (GitHub user/org 404, repo
  search 0, npm 404) but less recognizable — neither adopted.
- **SessionBridge / `sessbridge` adopted**: GitHub user/org 404, repo search
  total_count=0, npm 404; semantically precise for "session-level two-way interaction";
  Chinese "会话桥" short and natural.

## 3. Overall model

### 3.1 Channel topology

```
External clients (PowerShell / Python / ProofRail agent)
    │  write <channel_dir>/cmd_<targetPid>.json   (outbound message)
    │  read  <channel_dir>/res_<targetPid>.json   (receipt / reply)
    ▼
SessionBridge extension (VS Code, polls <channel_dir>)
    │  handles only command files matching its own process.ppid
    │  dispatches by mode:
    │    visible → chat panel delivery + session event capture (human/AI reply)
    │    silent  → LM API direct → capture AI response (zero UI)
    │    auto    → silent first, fall back to visible
    ▼
VS Code Copilot Chat (session, context, human review/confirmation)
```

- **Definition of session-level two-way**: `outbound` (external → Chat delivery) and
  `inbound` (Chat/human → external reply) form one conversation turn;
  `conversationId + turnId` identify turns and support continuing an existing session.
- Channel directory default: `%TEMP%\sessbridge` (Windows) / `$TMPDIR/sessbridge` (POSIX);
  overridable with `SESSBRIDGE_CHANNEL_DIR` (consistency requirement: caller and extension must agree).

### 3.2 Multi-instance routing

- Each VS Code instance's extension only handles channel files **named after its own
  main-window PID** (validates `process.ppid`).
- The caller specifies the target instance via `targetPid`; integrated-terminal calls
  automatically use `$env:VSCODE_PID`; external terminals auto-detect or specify explicitly.
- When runtime detection fails and no target is given: fall back to the legacy shared
  path (`vscode_chat_send_cmd.json` / `vscode_chat_send_res.json`), handled in compat mode
  by the extension (see §6).

## 4. Message envelope and receipt (v1)

### 4.1 Message envelope (outbound, `cmd_<pid>.json`)

```json
{
  "requestId": "sess-<auto-uuid>",
  "mode": "visible | silent | auto",
  "priority": "high | normal",
  "message": "string",
  "targetPid": 12345,
  "timeoutMs": 90000,
  "lmResponseTimeoutMs": 180000,
  "conversationId": "optional-existing-session-context",
  "turnId": 0,
  "createdAt": "2026-09-04T00:00:00Z",
  "legacy": false
}
```

Field contract:

- When `requestId` is not provided the client generates one (`sess-` prefix + uuid);
  **the receipt must bind to the same requestId**.
- `priority=high`: interrupt the current AI work and send immediately (event-driven
  ticket); `normal`: queue (status ticket).
- `timeoutMs`: caller's receipt wait limit; `lmResponseTimeoutMs`: override the
  extension-side LLM response wait for silent mode (this request only); when omitted, the
  extension default is used.
- Before writing the command file, the client **must first clean up stale result files for
  that requestId** (delete old results first, then write the new command — prevents
  deleting this round's fresh reply and causing a false `poll_timeout`; inherited from the
  verified whois pitfall).
- The client must write command files **atomically** (same-directory temp file +
  rename/replace); never write directly to the target file: the extension discovers files
  by polling and must never see a half-written state; the command-file direction has the
  same requirement as the receipt direction.

### 4.2 Receipt (inbound, `res_<pid>.json`)

```json
{
  "schemaVersion": "1",
  "requestId": "sess-<same-as-outbound>",
  "status": "ok | lm_api_unavailable | extension_error | busy | timeout | ...",
  "mode": "visible | silent | auto",
  "response": "AI or human reply text (may be empty)",
  "humanReply": "human reply (captured in visible two-way turns, may be empty)",
  "conversationId": "session context",
  "turnId": 1,
  "error": "extension-side error detail",
  "polledMs": 1234,
  "extensionVersion": "x.y.z",
  "finishedAt": "2026-09-04T00:00:05Z"
}
```

- The extension process must **exclusively write** result files (temp file + atomic
  rename); callers poll and read.
- `humanReply` is non-empty only within `visible` two-way turns; silent has no human
  participation.
- The receipt `status` value set is frozen at implementation time and enters the golden samples.

### 4.3 Exit-code contract (client exit codes, inherited from whois)

| Exit code | Meaning |
|---|---|
| `0` | success (receipt received and status=ok) |
| `1` | local transport failure (poll_timeout / write_cmd_failed / channel directory unavailable) |
| `2` | extension-side failure (status=extension_error / lm_api_unavailable) |
| `3` | parameter validation failure |

### 4.4 Idempotency and concurrency

- `requestId` dedup: the extension handles repeated requestIds idempotently; client
  retries MUST reuse the requestId (same attempt).
- Result files are single-instance, atomically written; `high` priority interrupt
  semantics apply only to this instance.
- Message and receipt lifetime: stale files beyond the retention period (default 24h) or
  already consumed are cleaned by extension/caller; cleanup actions are logged to diagnostics.
- **Serialization of the same response file (overlapping requests with different
  `requestId`s)**: the response file (`res_<pid>.json` and legacy equivalents) is a single
  slot that can carry only one receipt at a time. The extension maintains an in-flight
  flag **keyed by response file path**: if the previous command (any requestId) is still
  being processed, a new command to the same path **immediately** returns
  `status: "busy"` (legacy: `reason: "busy"`) instead of letting two writes overwrite each
  other — which would silently swallow the earlier request's receipt and make the caller
  misjudge it as `poll_timeout`. On `busy`, callers should back off and retry; the client
  exit code classifies it as `2` (extension-side failure, not local transport failure).
  The new-protocol channel and the legacy channel use different physical files, so they are
  not affected by this limitation.
- **Corrupt command file quarantine**: when a command file cannot be parsed as JSON, the
  extension must rename it aside (`<file>.bad-<pid>-<timestamp>`) and write a diagnostic
  record (`diag_<pid>.json`, `reason: "invalid_command_payload"`). It must not leave it in
  place and keep reading it on the next poll — that would cause silent infinite retries and
  leave the caller seeing only `poll_timeout` without a locatable root cause.
- **Idempotent replay of success receipts** (responding to the residual race of the
  single-slot receipt): the receipt file is a single slot, so a small window still exists
  between the client's "delete stale receipt then write command" and the extension's
  `busy` write — concurrent request B's `busy` may overwrite just-finished request A's
  receipt, causing A's caller to see one false `poll_timeout`. Handling: the client retries
  reusing the same `requestId` per RFC §4.4; the extension keeps an in-memory cache
  (default 5 minutes, ≤50 entries, keyed by `requestId`) for **success-class** receipts
  (`status=ok/discovery` or legacy `success=true`); on a new command with the same
  `requestId`, same channel file, same message, it **replays the cached receipt directly**
  without repeating side effects (paste/LM call). Error-class receipts are not cached;
  retries must really re-execute. This mechanism does not change the wire protocol shape
  (the receipt is still `res_<pid>.json`).

## 5. Mode semantics (frozen after S0 capability verification)

| Mode | Direction | Depends on | Positioning |
|---|---|---|---|
| `visible` | two-way | VS Code Chat API (session events, panel delivery, human-reply capture) | **Primary work mode**: full chat history, human–AI exchange, review/confirmation at critical checkpoints; ProofRail development relies on it |
| `silent` | one-way (AI reply) | LM API (non-public interface; needs compatibility matrix) | unattended status tickets / low-disruption automation |
| `auto` | depends on capability | silent first, fall back to visible | compatibility/convenience |

- **S0 capability spike** (cannot be skipped): verify that visible two-way capability is
  available on the target VS Code/Copilot version; if limited by the host API, keep the
  one-way "delivery + poll receipt" semantics and supplement human replies through a
  controlled receipt file, record it truthfully in the capability matrix, **must not**
  degrade to GUI automation.
- The compatibility matrix must record: VS Code version, Copilot extension version, LM API
  availability, chat-event availability.

## 6. Legacy protocol compatibility mode

- Compatibility identification: `legacy=true`, or channel files use whois old names
  `vscode_chat_send_cmd_<pid>.json` / `vscode_chat_send_res_<pid>.json` (and PID-less
  shared old names).
- Semantics: equivalent to the whois existing implementation (modes, priority, requestId
  binding, polling/timeout, discovery `--discover` allows empty message, parallel PS/Python
  exit codes 0/1/2/3).
- Acceptance: whois existing `Send-IpcChatMessage.ps1` / `ipc_chat_sender.py` regression
  passes fully in compat mode; whois A/B flows continue without modification.

## 7. Boundary with ProofRail (证轨)

- ProofRail's formal protocol declares and consumes only: the `silent` message layer +
  file queue channel, for programmable, automatically acceptable unattended delivery.
- `visible` session-level two-way/human interaction is a **SessionBridge product
  capability**, not part of ProofRail's formal protocol; ProofRail and SessionBridge are
  loosely coupled through the same message envelope (§4.1), with ProofRail choosing the
  mode and review mechanism per task policy.
- This RFC is the single authority for the channel contract; ProofRail-side RFC revisions
  (§9.7/§11 adapter protocol) are synchronized in the M2 phase after this protocol v1 freezes.

## 8. Cross-platform client strategy

- **Primary: Python 3** (stdlib first): `sessbridge send|wait|reply|discover`;
  behavior identical on Windows/Linux/macOS; whois existing `ipc_chat_sender.py` contract
  (exit codes, discovery mode, requestId generation, result binding) inherited 1:1.
- **Compat layer: PowerShell** (`sessbridge.ps1`, migration/thin wrapper of whois
  `Send-IpcChatMessage.ps1`): seamless Windows integration for existing whois scripts to
  switch gradually; locked against the Python implementation by the same contract tests,
  no drift.
- **sh client (`sessbridge.sh`)**: pure POSIX shell (no Python/Node/jq), same contract;
  for Linux/macOS and environments without Python.
- Go single-binary CLI listed as optional later (M3+); must pass contract equivalence
  tests before introduction.
- Anti-drift: golden samples (command/receipt/exit codes/multi-instance/priority/timeout)
  are driven uniformly by the contract tests.

## 9. Security boundary (v1)

- Local single-user threat model; channel directory defaults to the user temp directory;
  **no strong isolation/sandbox claim**.
- Messages must not contain confidential credentials — this is a **caller convention**;
  the current implementation does no redaction: diagnostic files (`diag_*.json`) and
  receipts (`res_*.json`) pass through `message`/`response`/environment metadata
  (version, PID, API availability, etc.) verbatim, no regex scanning or masking. If
  redaction guarantees are needed, handle it before writing the message; this repository
  has no acceptance test or golden sample for that capability.
- Multi-instance routing is based on PID validation; to prevent cross-user crosstalk the
  channel directory must be isolated per user.
- Stale command/result files are actively cleaned; atomic writes + exclusive writes avoid
  read/write races.
- Minimal extension privilege: reads only channel files matching its own ppid, writes only
  its own result files.

## 10. Implementation phases (summary)

| Phase | Deliverable | Acceptance |
|---|---|---|
| S0 | VS Code Chat API two-way capability spike, mode semantics freeze, capability matrix | capability matrix clear; degradation route confirmed |
| M1 | extension + Python/PS/sh clients + installer + legacy compat mode | whois existing regression all pass; contract tests all pass |
| M2 | `conversationId/turnId/humanReply` session turns, contract test extension | human review/confirmation end-to-end PASS |
| M3 | release: vsix + client package + SHA256 + compatibility matrix + CI (GitHub public + Gitee mirror) | three-platform client regression PASS |
| M4 | whois-side caller script switch (old implementation kept during transition) | whois equivalence validation PASS |

## 11. Open questions

1. The concrete dependency for `visible` two-way human-reply capture (chat participant
   event vs panel polling) — decided at S0.
2. Default channel directory location and multi-user isolation details — decided at S0/M1.
3. Python client package name (PyPI `sessbridge` pending confirmation) and distribution channel.
4. whois-side switch timing (M4) and how long the old implementation is retained.
