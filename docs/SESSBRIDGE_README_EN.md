# SessionBridge User Guide (EN)

> 简体中文：[SESSBRIDGE_README.md](SESSBRIDGE_README.md)

Session-level two-way interaction with VS Code Copilot Chat over a pure file/IPC
channel: deliver messages, capture AI replies (silent), visible delivery in the chat
panel (visible), and future human-reply capture (M2). No UI automation at all
(pywinauto / AHK).

Authoritative protocol: [RFC-sessbridge-channel-protocol-v1.md](RFC-sessbridge-channel-protocol-v1_EN.md)

## Architecture overview

```
External clients (Python / PowerShell / sh / ProofRail agent)
    │  write <channel_dir>/cmd_<targetPid>.json      (outbound message, v1 envelope)
    │  read  <channel_dir>/res_<targetPid>.json      (receipt / reply)
    ▼
SessionBridge extension (VS Code, polls <channel_dir>)
    │  handles only command files matching its own process.ppid
    │  dispatches by mode:
    │    visible → chat panel delivery + session event capture (human/AI reply, M2)
    │    silent  → LM API direct → capture AI response (zero UI)
    │    auto    → silent first, fall back to visible
    ▼
VS Code Copilot Chat (session, context, human review/confirmation)
```

- Channel directory default: `%TEMP%\sessbridge` (Windows) / `$TMPDIR/sessbridge` (POSIX);
  override with the `SESSBRIDGE_CHANNEL_DIR` env var (**caller and extension must agree**).
- Multi-instance routing: each VS Code instance only handles instance-specific files where
  `pid == process.ppid`; the caller targets a specific instance via `--target-pid` /
  `-TargetPid`.

## Repository file overview

| File | Purpose |
|------|---------|
| `extension/package.json` / `extension.js` | VS Code extension manifest and logic (chat tool adapter) |
| `client/sessbridge.py` | **Primary implementation**: Python 3 CLI (send/wait/reply/discover) |
| `client/ps/sessbridge.ps1` | PowerShell compat layer (Windows; contract identical to Python) |
| `client/sh/sessbridge.sh` | **sh client** (Linux/macOS/POSIX, pure shell; accepts PS and GNU-style parameters) |
| `pyproject.toml` | Installable Python client package (`sessbridge` command via pip) |
| `installer/install.ps1` / `uninstall.ps1` | Windows one-click install/uninstall |
| `installer/install.sh` / `uninstall.sh` | Linux/macOS (POSIX) install/uninstall |
| `installer/uninstall-legacy.ps1` / `.sh` | Remove the old whois `vscode-chat-sender` (prevents double install conflict) |
| `tests/golden/*.json` + `tests/test_contract.py` | Golden samples + contract tests |
| `tools/enforce_encoding.py` | Encoding/EOL convention gate |

## Installation

### Prerequisites

- VS Code >= 1.82
- GitHub Copilot extension (or another chat tool adapted via `SESSBRIDGE_CHAT_TOOL`)

### Windows

```powershell
# 1. Install the extension into VS Code
powershell -NoProfile -ExecutionPolicy Bypass -File "installer/install.ps1" -Force

# 2. Reload the VS Code window (Ctrl+Shift+P → Developer: Reload Window)
```

After changing extension code, re-run the install script and reload the window.

### Python client (optional, pip install)

```powershell
# Install to create the `sessbridge` command (or call python client\sessbridge.py ... directly)
python -m pip install --no-deps .

# Usage
sessbridge send --message "hello"
```

### Linux / macOS (POSIX)

```sh
# 1. Install the extension into VS Code (default ~/.vscode/extensions)
sh installer/install.sh

# Custom extension directory (VSCodium / Cursor / portable builds, etc.)
sh installer/install.sh --dir ~/.vscode-oss/extensions
VSCODE_EXTENSIONS_DIR=~/.cursor/extensions sh installer/install.sh

# Force reinstall
sh installer/install.sh --force

# 2. Reload VS Code: Command Palette (Ctrl+Shift+P) → Developer: Reload Window, or quit and reopen
#    (some Linux distributions can also use the xdg shortcut / window restart)

# Verify
code --list-extensions | grep -i sessbridge

# Uninstall / remove the old whois extension (prevents double install conflict)
sh installer/uninstall.sh [--dir <extensions-dir>]
sh installer/uninstall-legacy.sh
```

> PS1 and SH behave the same (`--force`/`--dir`; `VSCODE_EXTENSIONS_DIR` corresponds to
> Windows' fixed `$env:USERPROFILE\.vscode\extensions` path, handled inside the `.ps1`).

## Usage

### Python (primary)

Subcommands: `send` / `wait` / `reply` / `discover`.

- `send`: deliver a new message and wait for the receipt (optionally pass
  `--conversation-id` to keep context across turns);
- `reply`: continue an existing conversation (`--conversation-id` **required**;
  envelope equivalent to `send` + conversation id);
- `wait`: wait for a receipt already produced by another process (read-only,
  no delivery); `discover`: list available LM models.

Common parameters (supported by all subcommands):

| Parameter | Description | Default |
|------|------|---------|
| `--message` | message text (required for `send`/`reply`) | — |
| `--request-id` | receipt binding ID (auto `sess-<uuid>`; retries reuse the same ID idempotently) | auto |
| `--target-pid` | target VS Code main-window PID (0=auto-detect) | 0 |
| `--channel-dir` | channel directory override (aligned with PS `-ChannelDir`) | env var or `%TEMP%\sessbridge` |
| `--timeout` | seconds to wait for the receipt | 30 |
| `--poll-interval` | polling interval in ms | 200 |
| `--json-output` | output JSON receipt (for scripts) | off |
| `--keep` | keep the file after reading the receipt (post-analysis/audit) | off |
| `--legacy` | legacy protocol (whois file names/payload, for the whois transition) | off |
| `--mode` | `visible` / `silent` / `auto` | visible |
| `--priority` | `normal` (queue) / `high` (interrupt) | normal |
| `--auto-escalate` | auto-retry as high after normal timeout | off |
| `--model` | LM model name/ID (silent/auto) | empty (auto-select) |
| `--model-options` | JSON model options (e.g. `{"thinking_mode":"deep"}`) | none |
| `--lm-response-timeout-ms` | per-request override of the extension-side LM wait (1000–3600000) | 0 (extension default) |
| `--conversation-id` | session context ID (required for `reply`; optional for `send` — enables multi-turn history) | empty |
| `--turn-id` | turn number (optional; omitted = auto-increment from history; 0 = explicit new turn) | omitted (auto-increment) |
| `--reset-history` | explicitly reset and clear conversation history (restart fresh) | off |
| `--no-compress` | bypass smart compression of assistant response for critical checkpoints | off |

`wait` additionally supports `--res-file <path>` (explicit receipt file, advanced);
`discover` does not require `--message`.

```powershell
# Basic usage (visible: appears in the chat panel)
python client\sessbridge.py send --message "你的消息"

# request-id (tracing/receipt binding)
python client\sessbridge.py send --message "你好" --request-id msg001

# High priority — interrupt the current AI work (event-driven ticket)
python client\sessbridge.py send --message "紧急事件" --priority high

# Normal priority — queue (status ticket), auto-escalate to high after timeout
python client\sessbridge.py send --message "状态报告" --priority normal --auto-escalate

# JSON output (for scripts)
python client\sessbridge.py send --message "test" --json-output

# Silent mode — LM API direct, zero UI, captures the AI response
python client\sessbridge.py send --message "例行状态" --mode silent --timeout 90

# Silent + specific model + thinking mode + per-request extension timeout override
python client\sessbridge.py send --message "长任务" --mode silent \
  --model "DeepSeek V4 Flash" --model-options '{"thinking_mode":"deep"}' \
  --lm-response-timeout-ms 180000 --json-output

# Auto mode — silent first, fall back to visible
python client\sessbridge.py send --message "状态" --mode auto

# Continue a session (conversationId/turnId, M2 semantics)
python client\sessbridge.py reply --message "继续" --conversation-id conv-x

# Wait for an existing receipt (another process already sent it; read the result here)
python client\sessbridge.py wait --request-id msg001

# List available LM models
python client\sessbridge.py discover

# Legacy protocol compatibility (whois file names/payload, for the whois transition)
python client\sessbridge.py send --message "hello" --legacy

# Custom timeout/poll interval (quick smoke / slow long task)
python client\sessbridge.py send --message "test" --timeout 10 --poll-interval 100
python client\sessbridge.py send --message "慢查询" --timeout 120

# Fixed request-id + specific instance + JSON (unattended scripts)
python client\sessbridge.py send --message "状态" --request-id msg001 --target-pid 6288 --json-output

# Custom channel directory (aligned with PS -ChannelDir)
python client\sessbridge.py send --message "x" --channel-dir "D:\temp\sb" --json-output

# Keep the receipt file (post-analysis)
python client\sessbridge.py send --message "test" --keep --json-output

# Model options (keys depend on the model, e.g. DeepSeek thinking_mode)
python client\sessbridge.py send --message "x" --mode silent --model "DeepSeek V4 Flash" \
  --model-options '{"thinking_mode":"deep"}'

# Wait for an existing receipt (another process sent it; read here; explicit file allowed)
python client\sessbridge.py wait --request-id msg001 --keep
python client\sessbridge.py wait --conversation-id conv-x --res-file "D:\tmp\res_4242.json"

# Continue a session with a turn number (M2 semantics, v1 passes through)
python client\sessbridge.py reply --message "继续" --conversation-id conv-x --turn-id 1
```

### Silent conversation history (multi-turn context, RFC §5.1)

Without `--conversation-id` the client stays **stateless single-turn** (legacy
behavior).  With a non-empty `--conversation-id`, the extension maintains a
per-session message history (`history_<conversationId>.json`) and assembles
`requests = history + current message` on every turn, so the AI can reference
earlier facts and keep working:

```powershell
# Turn 1: start a session (turnId 0); receipt carries history health metrics
python client\sessbridge.py send --message "Phase 1 task brief" --mode silent `
  --conversation-id prfrail-phase-1 --turn-id 0 --json-output

# Turn 2: continue with context (no need to repeat the whole background)
python client\sessbridge.py send --message "Continue from the previous step" --mode silent `
  --conversation-id prfrail-phase-1 --turn-id 1 --json-output

# Phase done: explicitly reset (clear history, current message becomes new anchor)
python client\sessbridge.py send --message "Start a new phase" --mode silent `
  --conversation-id prfrail-phase-1 --reset-history --no-compress --json-output
```

- The receipt `history` field (`totalTurns`/`inputTokensEst`/`isTruncated`/
  `evictedTurns`) lets scripts assess context health;
- For critical deliveries (diff/config/code) add `--no-compress` to bypass smart
  truncation;
- History defaults: last 20 turns / ~24K tokens / ≤1MB per file; eviction
  preserves "head (anchor) + tail", is recorded and archived (never silent);
- A new `--conversation-id` starts a completely fresh session (cheapest "reset").

### Human reply (visible two-way, RFC §5.2)

Human review/confirmation: in the chat panel use **`@sbr-review`** (the `@` list-item
name; after selecting it becomes a participant token).

```text
@ sbr-review  prfrail-review-1  approved
```

- Format: `@sbr-review <conversationId> <reply text>`; the extension fails closed
  (missing conversation id / empty reply shows a panel hint);
- On success the panel confirms "已记录人工回复 → reply_<conversationId>.json";
- Callers read it with `wait --conversation-id <cid>` → `humanReply` (consumed by
  default; `--keep` retains), closing the "deliver → human review → receipt" loop.

```powershell
# After a human types @sbr-review prfrail-review-1 approved in the panel:
python client\sessbridge.py wait --conversation-id prfrail-review-1 --json-output
# => humanReply: "approved"
```

### PowerShell (compat layer, Windows)

The parameter set is a **superset of whois' `Send-IpcChatMessage.ps1`** (all whois
parameters retained, new: `ChannelDir` / `Legacy` / `ConversationId` / `TurnId`):

| Parameter | Description | Default |
|------|------|---------|
| `-Message` | message text (required for the Send parameter set; not needed for `-DiscoverModels`) | — |
| `-RequestId` | receipt binding ID (auto `sess-<uuid>`) | auto |
| `-JsonOutput` | output JSON receipt | off |
| `-KeepTempFiles` | keep the receipt file after reading | off |
| `-TargetPid` | target instance PID (0=auto-detect) | 0 |
| `-Priority` | `normal` / `high` | normal |
| `-AutoEscalate` | auto-retry as high after normal timeout | off |
| `-TimeoutSec` | wait seconds (1–5400) | 30 |
| `-PollIntervalMs` | polling interval ms (50–2000) | 200 |
| `-Mode` | `Silent` / `Visible` / `Auto` | Visible |
| `-Model` | LM model name/ID | empty (auto-select) |
| `-ModelOptions` | hashtable model options (e.g. `@{ thinking_mode = "deep" }`) | none |
| `-LmResponseTimeoutMs` | per-request override of the extension-side LM wait (1000–3600000) | 0 |
| `-DiscoverModels` | list available models (Discover parameter set, no `-Message` needed) | off |
| `-ChannelDir` | channel directory override | `%TEMP%\sessbridge` |
| `-Legacy` | legacy protocol (whois file names/payload) | off |
| `-ConversationId` | session context ID | empty |
| `-TurnId` | turn number (optional; omitted/-1 = auto-increment from history; 0 = explicit first turn) | -1 (auto-increment) |
| `-ResetHistory` | explicitly reset and clear conversation history | off |
| `-NoCompress` | bypass assistant response compression for critical checkpoints | off |

```powershell
.\client\ps\sessbridge.ps1 -Message "你的消息"
.\client\ps\sessbridge.ps1 -Message "状态" -Mode Silent -Model "DeepSeek V4 Flash" -JsonOutput
.\client\ps\sessbridge.ps1 -Message "紧急" -Priority high
.\client\ps\sessbridge.ps1 -Message "x" -DiscoverModels
.\client\ps\sessbridge.ps1 -Message "x" -Legacy -JsonOutput

# Custom timeout/poll interval (quick smoke / slow long task)
.\client\ps\sessbridge.ps1 -Message "test" -TimeoutSec 10 -PollIntervalMs 100 -JsonOutput
.\client\ps\sessbridge.ps1 -Message "慢查询" -TimeoutSec 120

# Long task: per-request extension timeout override (no VS Code restart needed)
.\client\ps\sessbridge.ps1 -Message "长任务" -Mode Silent -TimeoutSec 120 -LmResponseTimeoutMs 180000 -JsonOutput

# Model options (hashtable)
.\client\ps\sessbridge.ps1 -Message "x" -Mode Silent -Model "DeepSeek V4 Flash" -ModelOptions @{ thinking_mode = "deep" }

# Keep the receipt file (post-analysis)
.\client\ps\sessbridge.ps1 -Message "test" -KeepTempFiles -JsonOutput

# Specific instance / custom channel directory / legacy protocol
.\client\ps\sessbridge.ps1 -Message "hi" -TargetPid 6288
.\client\ps\sessbridge.ps1 -Message "hi" -ChannelDir "D:\temp\sb"
.\client\ps\sessbridge.ps1 -Message "hi" -Legacy

# Session turn (-TurnId 0 = explicit first turn)
.\client\ps\sessbridge.ps1 -Message "继续" -ConversationId conv-x -TurnId 1
```

### sh client (Linux / macOS / POSIX)

Pure POSIX shell implementation (`client/sh/sessbridge.sh`), **no Python / Node / jq
required**; accepts both PowerShell-style (`-Message`) and GNU-style (`--message`)
parameters, values case-insensitive.

| Parameter (PS style / GNU style) | Description | Default |
|------|------|---------|
| `-Message` / `--message` | message text | empty |
| `-Mode` / `--mode` | `Silent` / `Visible` / `Auto` (case-insensitive) | visible |
| `-Model` / `--model` | LM model name/ID (silent/auto) | empty (auto-select) |
| `-RequestId` / `--request-id` | receipt binding ID (auto `sess-<epoch>-<hex>`) | auto |
| `-TargetPid` / `--target-pid` | target instance PID (0=auto-detect) | 0 |
| `-ChannelDir` / `--channel-dir` | channel directory override | `$TMPDIR/sessbridge` |
| `-TimeoutSec` / `--timeout` | wait seconds | 30 |
| `-PollIntervalMs` / `--poll-interval` | polling interval ms | 200 |
| `-KeepTempFiles` / `--keep` | keep the receipt file after reading | off |
| `-JsonOutput` / `--json-output` | output JSON receipt | off |
| `-Pretty` / `--pretty` | multiline readable receipt (Format-List style) | off |
| `-Legacy` / `--legacy` | legacy protocol (whois file names/payload) | off |
| `-Priority` / `--priority` | `normal` / `high` | normal |
| `-AutoEscalate` / `--auto-escalate` | auto-retry as high after normal timeout | off |
| `-LmResponseTimeoutMs` / `--lm-response-timeout-ms` | per-request extension-side LM wait override | 0 |
| `-ConversationId` / `--conversation-id` | session context ID | empty |
| `-TurnId` / `--turn-id` | turn number (optional; omitted = auto-increment from history; 0 = explicit first turn) | omitted (auto-increment) |
| `-ResetHistory` / `--reset-history` | explicitly reset and clear conversation history | off |
| `-NoCompress` / `--no-compress` | bypass assistant response compression for critical checkpoints | off |
| `-DiscoverModels` / `--discover` / `-d` | list available models | off |

- PID resolution order: `-TargetPid` → `$VSCODE_PID` → `pgrep` → `ps -W` (Git Bash);
  when unresolved, fall back to the legacy shared path (needs `-Legacy`).
- `-h` / `--help` shows help; exit codes match Python/PS (0/1/2/3).

```bash
# Basic usage (visible: appears in the chat panel)
sh client/sh/sessbridge.sh -Message "你的消息"

# Silent mode + specific model + JSON (capture AI response)
sh client/sh/sessbridge.sh -Message "例行状态" -Mode Silent \
  -Model "DeepSeek V4 Flash Vision Exp" -JsonOutput

# Multiline readable receipt (equivalent to PS ConvertFrom-Json | Format-List)
sh client/sh/sessbridge.sh -Message "状态" -Mode Silent \
  -Model "DeepSeek V4 Flash Vision Exp" -Pretty

# List available LM models
sh client/sh/sessbridge.sh -DiscoverModels

# Keep receipt / specific instance / custom channel directory / legacy protocol
sh client/sh/sessbridge.sh -Message "test" -KeepTempFiles -JsonOutput
sh client/sh/sessbridge.sh -Message "hi" -TargetPid 6288
sh client/sh/sessbridge.sh -Message "hi" -ChannelDir "/tmp/sb"
sh client/sh/sessbridge.sh -Message "hi" -Legacy

# Timeout/poll interval/priority/auto-escalate
sh client/sh/sessbridge.sh -Message "test" -TimeoutSec 10 -PollIntervalMs 100
sh client/sh/sessbridge.sh -Message "紧急" -Priority high
sh client/sh/sessbridge.sh -Message "状态" -AutoEscalate

# Session turn (-TurnId 0 = explicit first turn)
sh client/sh/sessbridge.sh -Message "继续" -ConversationId conv-x -TurnId 1
```

> The Python / PowerShell / sh clients are locked to a single contract
> (RFC + golden samples + contract tests); behavior drift is forbidden.

## Communication protocol

### File naming rules (new protocol, inside the channel directory)

```
Command file:  <channel_dir>\cmd_<targetPid>.json
Result file:   <channel_dir>\res_<targetPid>.json
Diagnostic:    <channel_dir>\diag_<pid>.json / diag_<pid>-lm.json (extension activation probe)
```

### Legacy protocol compatibility (whois, always in the system temp directory)

```
Command file:  %TEMP%\vscode_chat_send_cmd_<pid>.json (or shared vscode_chat_send_cmd.json)
Result file:   %TEMP%\vscode_chat_send_res_<pid>.json (or shared vscode_chat_send_result.json)
```

### Command file (input, v1 envelope)

```json
{
  "schemaVersion": "1",
  "requestId": "sess-<uuid>",
  "mode": "visible",
  "priority": "normal",
  "message": "message to send",
  "targetPid": 12345,
  "timeoutMs": 30000,
  "lmResponseTimeoutMs": 180000,
  "conversationId": "optional session context",
  "turnId": 0,
  "createdAt": "2026-09-04T00:00:00Z",
  "legacy": false
}
```

| Field | Description |
|------|---------|
| `requestId` | receipt binding ID (client generates `sess-` prefix; repeated requests reuse the same ID idempotently) |
| `mode` | `visible` / `silent` / `auto` |
| `priority` | `normal` (queue) / `high` (interrupt) |
| `timeoutMs` | caller's receipt wait limit (client-generated) |
| `lmResponseTimeoutMs` | optional per-request extension-side LM response wait (this request only) |
| `conversationId` / `turnId` | session turn identifiers (M2 semantics; v1 passes through/echoes) |
| `discover` | optional; when `true`, list available models (no message sent) |

### Result file (output, v1 receipt)

```json
{
  "schemaVersion": "1",
  "requestId": "sess-<same>",
  "status": "ok",
  "mode": "silent",
  "response": "AI or human reply text",
  "humanReply": "human reply (captured in visible two-way turns, M2; empty in v1)",
  "conversationId": "",
  "turnId": 1,
  "error": "",
  "polledMs": 0,
  "extensionVersion": "0.1.0",
  "finishedAt": "2026-09-04T00:00:05Z"
}
```

`status` values (M1): `ok` / `lm_api_unavailable` / `extension_error` / `no_message` /
`discovery` / `discovery_failed` / `timeout`. Plus `modeUsed` (actual path taken by auto)
and `model` (silent model info).

### Possible failure causes / exit codes

| Cause | Meaning | Client exit code |
|------|---------|------------------|
| `poll_timeout` | extension did not respond within the timeout | 1 |
| `write_cmd_failed:*` | caller failed to write the command file (local) | 1 |
| `lm_api_unavailable` | Silent mode LM API unavailable | 2 |
| `extension_error` / `no_message` | extension-side failure | 2 |
| parameter validation failure (empty message, etc.) | client-side local validation | 3 |

## Model selection strategy (silent/auto)

Controlled by the extension's `pickModel()`:

0. Caller-specified (`model` field, matched by name/ID)
1. `Auto` (Copilot auto-routing, usually consistent with the chat panel)
2. `DeepSeek V4 Flash` (current common default)
3. First available model (fallback)

## Long-running reply handling

- **Dual timeouts**: client polling timeout `--timeout` (default 30s, adjustable) +
  extension-side LM response wait `lmResponseTimeoutMs` (default 60000ms, per-request
  override without restarting VS Code).
- **Key constraint**: the extension host process's `process.env` and the integrated
  terminal environment are **independent** — setting
  `$env:SESSBRIDGE_LM_RESPONSE_TIMEOUT_MS=...` in the terminal is **invisible** to the
  extension; for a global effect use a system/user environment variable and restart
  VS Code, or override per request.
- Visible mode returns immediately after paste+submit (non-blocking, no `response`).

## Mode comparison

| Mode | Can get `response` | Caller blocks | Use case |
|------|--------------------|---------------|----------|
| `silent` + `--lm-response-timeout-ms` | ✅ full reply | = AI generation time | response content needed |
| `visible` | ❌ (no reply before M2) | very short | delivery only / human interaction |
| `auto` | ⚠️ depends on path | depends on path | compatibility/convenience |

## How it works

1. The extension activates at VS Code startup (`onStartupFinished`), creates the channel
   directory and writes capability probes (`diag_<pid>.json` / `diag_<pid>-lm.json`,
   for the S0 capability matrix).
2. Every `SESSBRIDGE_POLL_MS` (default 300ms) it polls: `cmd_<ppid>.json` (new protocol) →
   legacy PID-scoped → legacy shared file.
3. On reading a command file: deletes it (at-most-once), dispatches by `mode`:
   - `visible`: `removePending` → (for `high` first `cancel`) → `open` → clipboard →
     `focusInput` → paste → `queueMessage`/`submit`; writes the receipt immediately on success.
   - `silent`: `vscode.lm` (via adapter) direct, collects `response.text`, writes the receipt.
   - `auto`: silent first, fall back to visible (receipt notes `modeUsed`).
4. Receipts are written via temp file + atomic rename; the caller polls and reads
   (deletes after read; `--keep` retains).
5. Stale files (>24h) are periodically cleaned up by the extension with a diagnostic record.

## Chat tool adaption (future Continue etc.)

- The extension reaches concrete chat tools only via `TOOL_ADAPTERS` (`extension.js`),
  default `copilot` (switchable with `SESSBRIDGE_CHAT_TOOL`; falls back to copilot when
  unset).
- Adding a new tool: add an adapter (panel command IDs + LM API wrapper); clients and the
  protocol stay unchanged.
- See [CODING_CONVENTIONS_EN.md](CODING_CONVENTIONS_EN.md) §4.

## Debugging

```powershell
# Channel directory (default)
Get-ChildItem "$env:TEMP\sessbridge"

# View capability probes (S0)
Get-Content "$env:TEMP\sessbridge\diag_$env:VSCODE_PID.json"

# Keep the result file for post-analysis
python client\sessbridge.py send --message test --keep --json-output

# Clean up channel files
Remove-Item "$env:TEMP\sessbridge\cmd_*.json","$env:TEMP\sessbridge\res_*.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:TEMP\vscode_chat_send_*.json" -Force -ErrorAction SilentlyContinue
```

## FAQ

### Q1: How do I send a message to a specific VS Code instance?

`Get-Process -Name Code | Where-Object MainWindowTitle` only shows main windows (filters
out child processes). Use `--target-pid <Id>` / `-TargetPid <Id>` for precise delivery.
Multiple windows in the same process (same PID) cannot be distinguished at the process
level — the message goes to that process's active chat; use a different VS Code
Profile/version if strict separation is required.

### Q2: How do I avoid the "keep/remove" prompt?

Both priorities call `removeAllPendingRequests` to clear the queue before sending:
`normal` → `queueMessage`; `high` → clear queue + `cancel` + `submit`.
`--auto-escalate` remains the safety net: normal timeout auto-retries as high.

### Q3: Newlines and quotes in messages?

Python: `--message "line1\nline2"` (JSON serialization keeps `\n`).
PowerShell: here-string or single-quoted outer wrapper; `\n` in JSON is parsed by the
extension as a newline. Verify the actual content with `--json-output`/`-JsonOutput`.

### Q4: Does Silent mode return the "raw model reply" or "tool execution trace"?

One request → one response: AI intermediate actions (reading files / editing code /
calling terminals) are not transmitted separately; the extension keeps collecting chunks
until generation finishes, then writes them at once. Timeout truncation is marked with
`aiResponseTruncated` / (legacy) `ai_response_truncated`.
