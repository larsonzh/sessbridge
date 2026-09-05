# SessionBridge Quick Troubleshooting (EN)

> 简体中文：[SESSBRIDGE_TROUBLESHOOTING_CN.md](SESSBRIDGE_TROUBLESHOOTING_CN.md)

Applies to: `client/sessbridge.py`, `client/ps/sessbridge.ps1`, `client/sh/sessbridge.sh`,
`extension/extension.js`, and callers that integrate through the `silent` message layer
(e.g. ProofRail).

## 1. 30-second quick triage

1. Check the exit code first: `0`=receipt received and status=ok; `1`=local transport
   failure; `2`=extension-side failure; `3`=validation failure.
2. No exit code or the process hangs: **first confirm the extension is installed and the
   window reloaded** (most common cause).
3. `poll_timeout` — suspect first: channel directory mismatch / target PID mismatch /
   extension not activated.
4. `lm_api_unavailable` — suspect first: LM channel not ready (empty model list / not
   signed in / network proxy).
5. Message not shown but exit code 0: check the chat panel/chat worker; visible was
   submitted but that does not mean the AI is responding.

## 2. Common failures -> actions

### A. `poll_timeout` (extension not responding)

Symptom: client polling times out, exit code 1.

Actions (in order):
1. `code --list-extensions | Select-String larsonzh` to confirm `larsonzh.sessbridge` exists.
2. `Ctrl+Shift+P → Developer: Reload Window`.
3. Check channel directory consistency: caller and extension must use the same
   `SESSBRIDGE_CHANNEL_DIR`; both default to `%TEMP%\sessbridge` — **never** have one side
   default and the other customized.
4. Check target PID: integrated terminal uses `$env:VSCODE_PID`; external terminal needs
   `--target-pid` or auto-detection; when detection fails, fall back to legacy shared
   files (`-Legacy`).
5. Still failing: reinstall the extension (Windows `installer\install.ps1 -Force`;
   Linux/macOS `sh installer/install.sh --force`) and reload.
6. Check whether `%TEMP%\sessbridge\diag_<pid>.json` shows `extension_activated`.
   (POSIX channel directory defaults to `$TMPDIR/sessbridge`.)

### B. Channel directory mismatch (new/legacy mixed)

Symptom: client writes `cmd_<pid>.json` to directory A, the extension polls directory B.

Actions:
- Unify `SESSBRIDGE_CHANNEL_DIR`; check for leftover environment variables from old sessions.
- Shared legacy files always live in `%TEMP%`, unrelated to `SESSBRIDGE_CHANNEL_DIR`
  (by design — do not change).

### C. Multi-instance routing crosstalk / instance not found

Symptom: message went to the wrong VS Code window.

Actions:
- `Get-Process -Name Code | Where-Object MainWindowTitle | Format-Table Id,StartTime`
  to see only main windows; use `--target-pid` explicitly.
- Multiple windows in the same process (same PID) cannot be distinguished — inherent
  limitation (see guide Q1).

### D. Silent mode `lm_api_unavailable`

Symptom: exit code 2, status=`lm_api_unavailable`.

Actions:
1. `python client\sessbridge.py discover` to check whether the model list is empty.
2. Empty model list: confirm the Copilot/corresponding LM channel is signed in and the
   proxy is configured.
3. `model_options` keys depend on the specific model (not publicly documented);
   wrong keys can make the model reject the request.

### E. Encoding pitfalls (JSON BOM / PS 5.1 mojibake)

Symptom:
- Extension reports `Unexpected token` / command file parse failure.
- Chinese text garbled in PowerShell.

Actions:
- JSON written for Node to parse **must be BOM-free**: in PS use
  `[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))`;
  in Python use `json.dump(..., ensure_ascii=False)` (no BOM by default).
- Repo Markdown/PS/JSON follow the BOM+LF convention (`tools\enforce_encoding.py` gate),
  but **runtime IPC files are not repo files**: always BOM-free and no CRLF conversion.

### F. Inline `if` subexpression in PowerShell 5.1 (key pitfall)

Symptom: script fails midway with `The term 'if' is not recognized...`.

Root cause: string interpolation of `$(if (...) { } else { })` triggers a syntax error in
PS 5.1.

Actions: never use inline `$(if...)` in unattended critical scripts; compute the variable
first, then pass it. Detect with:
`rg --line-number --glob "**/*.ps1" "\$\(if\s*\("`

### G. Stale results causing false `poll_timeout`

Symptom: occasional `poll_timeout`, immediate success on resend.

Root cause: deleting old results AFTER writing the new command deletes the fresh receipt
just written by the extension (historical pitfall).

Actions: the contract is fixed as "**delete stale results for the same requestId first,
then write the new command**" (RFC §4.1); upgrade old clients. Preserve the scene with
`--keep` / `-KeepTempFiles`.

### H. Old/new extension double-install conflict

Symptom: message delivered twice in legacy scenarios / receipts deleted by race.

Actions: both SessionBridge and the old `vscode-chat-sender` poll the legacy file names —
**keep only one**. During whois migration run `installer\uninstall-legacy.ps1`.

## 3. Checkpoints (unattended integration)

- Extension installed and window reloaded (`code --list-extensions | Select-String sessbridge`).
- If `SESSBRIDGE_CHANNEL_DIR` is set, the caller and extension agree.
- ProofRail consumes the `silent` message layer + file queue only: message carries
  `requestId`, `--auto-escalate` as needed, and after timeout classify by exit code
  (1=local, 2=extension-side).
- Message safety: messages must not contain confidential credentials — that is a **caller
  convention**; the extension/clients currently perform **no** redaction at all (diagnostic
  files and receipts pass through message/response content verbatim). If redaction is
  required, handle it before writing.

## 4. Minimal verification commands

```powershell
# Channel smoke (visible)
python client\sessbridge.py send --message "sessbridge-selftest" --json-output

# Silent direct + capture response
python client\sessbridge.py send --message "ping" --mode silent --timeout 60 --json-output

# Model discovery
python client\sessbridge.py discover

# Contract test self-check (local only, no VS Code required)
python tests\test_contract.py

# Encoding gate
python tools\enforce_encoding.py
```

## 5. Evidence and log locations

- Channel directory: `%TEMP%\sessbridge` (`cmd_*` / `res_*` / `diag_*`).
- Extension diagnostics: `diag_<pid>.json` (activation/API probe), `diag_<pid>-lm.json`
  (model probe).
- Legacy protocol files: `%TEMP%\vscode_chat_send_*`.
- Extension cleanup actions: `reason=stale_cleanup` in `diag_<pid>.json` (>24h stale files).

Verdict priority: client exit code / receipt JSON → `diag_*` probes → chat worker state.
Do not misjudge a "chat worker response interruption" as "send failure".
