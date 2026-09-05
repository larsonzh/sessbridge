# SessionBridge Dev Plan

> 简体中文：[DEV_PLAN.md](DEV_PLAN.md)

> Status: in progress (2026-09-04). Authoritative protocol:
> [RFC-sessbridge-channel-protocol-v1_EN.md](RFC-sessbridge-channel-protocol-v1_EN.md).
> This file is the engineering-side implementation mapping: it maps the RFC stages
> (S0/M1/M2/M3/M4) to concrete files and acceptance criteria.

## 1. Repository layout (target)

```
sessbridge/
  .github/workflows/   CI (three-platform contract tests + static gates + runtime smoke + release artifacts)
  extension/          VS Code extension (visible/silent/auto, multi-instance routing, legacy compat, S0 probe)
  client/
    sessbridge.py     Python 3 cross-platform CLI (send/wait/reply/discover)
    sessbridge.sh     POSIX sh client (Linux/macOS; no Python dependency)
    ps/
      sessbridge.ps1  PowerShell compat layer (Windows; contract identical to Python)
  installer/
    install.ps1 / install.sh / uninstall*.ps1 / uninstall*.sh
    build-vsix.ps1 / build-vsix.sh      vsix packaging (vsce)
  tools/
    enforce_encoding.py                 encoding/EOL gate
    make_checksums.ps1 / make_checksums.sh  release SHA256 manifest
  tests/
    golden/           golden samples (command/receipt/exit code/multi-instance/priority/timeout)
    test_contract.py  contract tests (mock extension + real clients)
    run-runtime-smoke.js  real VS Code Extension Host smoke launcher
    runtime-smoke/    Extension Host activation and file IPC smoke
  docs/
    RFC-sessbridge-channel-protocol-v1.md    protocol (authoritative)
    DEV_PLAN.md                              this file
    S0-CAPABILITY-SPIKE.md                   S0 capability verification checklist
    capability-matrix.md                     capability matrix (filled after S0)
```

## 2. Milestone mapping

| Milestone | Covered by this plan | Acceptance |
|---|---|---|
| **S0** | built-in capability probe in `extension/` (`diag_<pid>.json`); `docs/S0-CAPABILITY-SPIKE.md` checklist; `docs/capability-matrix.md` template | run the probe on the target VS Code/Copilot version, fill the capability matrix, confirm the visible two-way degradation route |
| **M1** | extension + Python CLI + PS compat layer + installer + legacy compat mode + contract tests (golden samples) | `tests/test_contract.py` all pass; whois legacy clients (`ipc_chat_sender.py` / `Send-IpcChatMessage.ps1`) pass regression in compat mode |
| **M2** | `conversationId/turnId/humanReply` session turns (semantics frozen after S0 conclusions) | human review/confirmation end-to-end PASS |
| **M3** | release: vsix + client package + SHA256 + compatibility matrix + CI | three-platform client regression PASS |
| **M4** | whois-side caller script switch (old implementation kept during transition) | whois equivalence validation PASS |

## 3. M1 implementation points (settled)

### 3.1 Channel directory and files

- Channel directory: overridden by `SESSBRIDGE_CHANNEL_DIR` env var, default
  `%TEMP%\sessbridge` (Windows) / `$TMPDIR/sessbridge` (POSIX); caller and extension must agree.
- New protocol files (inside the channel directory, PID-scoped):
  - `cmd_<pid>.json` (outbound, RFC §4.1 envelope)
  - `res_<pid>.json` (inbound, RFC §4.2 receipt)
  - `diag_<pid>.json` (diagnostics/capability probe)
- Legacy protocol files (always in the system temp directory, **not** using
  `SESSBRIDGE_CHANNEL_DIR`, preserving whois compatibility):
  - `vscode_chat_send_cmd_<pid>.json` / `vscode_chat_send_res_<pid>.json`
  - Shared legacy names: `vscode_chat_send_cmd.json` / `vscode_chat_send_result.json`

### 3.2 Routing and identity

- The extension only handles `cmd_<pid>` where `pid == process.ppid` (main window PID);
  shared legacy names are handled by any instance per the old behavior (same as whois today).
- Client target PID resolution order: `--target-pid` (validated as a Code process) →
  `$VSCODE_PID` → detect the first `Code.exe` with a window title; when unresolved, fall
  back to the legacy shared path (compat).

### 3.3 Mode semantics (frozen in M1; S0 only affects M2 enhancements)

- `visible`: chat panel delivery (clipboard + panel commands, reusing the verified whois
  mechanism); receipt returns immediately, `humanReply` left empty (M2 collects).
- `silent`: `vscode.lm` direct, captures the AI response into `response`; on failure
  `lm_api_unavailable`.
- `auto`: silent first, fall back to visible; receipt notes the actual path via `modeUsed`.
- Response must include: `status`, `requestId` echo, `finishedAt`, `polledMs`, `extensionVersion`.

### 3.4 Contract test strategy

- Golden samples: `tests/golden/*.json` fix envelope/receipt shapes; tests lock fields
  (anti-drift across implementations).
- Contract tests (`tests/test_contract.py`, stdlib only):
  - mock extension thread: detects `cmd` file → writes `res` (fast path), validates exit
    codes 0/1/2/3.
  - new protocol envelope field validation (`schemaVersion/requestId/mode/targetPid`).
  - legacy protocol compatibility (file names, `request_id`, `success/reason` shapes) and
    whois contract equivalence.
  - `discover`, timeout (exit 1), extension failure (exit 2), validation (exit 3).

## 4. Current progress

- [x] RFC protocol v1 (committed ee2f6c7)
- [x] Repository layout + dev plan
- [x] extension/ (M1 + S0 probe)
- [x] client/ (Python CLI + PS/sh compat layers)
- [x] installer/ (install/uninstall PS1+SH, build-vsix PS1+SH, legacy cleanup)
- [x] tests/ (golden samples + contract tests, 21 passed)
- [x] M3 release prep: CI (`.github/workflows/ci.yml` three-platform matrix) + vsix
  packaging scripts + SHA256 manifest tool + encoding gate (incl. golden)
- [x] Python client package (`pyproject.toml` → `sessbridge` command; wheel build
  verified; CI includes pip install smoke)
- [x] S0 capability probe run + capability matrix filled (verified on real VS Code 1.136.1)
- [x] Real VS Code runtime smoke (Extension Host activation + PID file IPC; separate CI job)
- [x] whois legacy client compat regression (2026-09-05 on real VS Code; visible delivery
  via legacy protocol; both PASS):
  - Python: whois `ipc_chat_sender.py` → receipt `success:true / sent_via_clipboard_fallback`;
    `request_id` (`auto-<uuid>`) and `priority:high` passed through unchanged
    (`vscode_chat_send_res_14948.json`)
  - PowerShell: whois `Send-IpcChatMessage.ps1` → `-JsonOutput` real run
    `success:true / sent_via_clipboard_fallback`, `request_id:auto-cef052cae36546e68da093875a019cfe`
    (`request_id_auto_generated:true`), `priority:normal` (no `-KeepTempFiles`; receipt removed
    after read per client convention)
  - Isolation: legacy `vscode-chat-sender` uninstalled and VS Code restarted;
    receipt attribution is unambiguous
- [x] M2 session turns (after S0 conclusions: §5.1 silent multi-turn + §5.2
  `@sbr-review` human reply, both end-to-end PASS)
- [ ] M3 official release (vsix + client package + SHA256 + compatibility matrix + CI badges)
