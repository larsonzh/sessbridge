# SessionBridge extension (VS Code)

File-based two-way IPC to Copilot Chat.  See
[docs/RFC-sessbridge-channel-protocol-v1.md](../docs/RFC-sessbridge-channel-protocol-v1.md).

- New channel: `%TEMP%\sessbridge` (override `SESSBRIDGE_CHANNEL_DIR`) —
  `cmd_<pid>.json` / `res_<pid>.json` / `diag_<pid>.json`.
- Legacy channel (whois compat): `%TEMP%\vscode_chat_send_cmd_<pid>.json` etc.
- Modes: `visible` (chat panel), `silent` (vscode.lm), `auto`.
- Multi-instance routing: only handles `cmd_<pid>` where `pid == process.ppid`.
- S0 capability probe: writes `diag_<pid>.json` + `diag_<pid>-lm.json` on activate.

Install: `powershell -File installer\install.ps1 -Force` from repo root.
