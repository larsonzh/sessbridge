# SessionBridge extension / 扩展（VS Code）

[简体中文](#简体中文) · [English](#english)

## 简体中文

基于文件通道的 VS Code Copilot Chat 双向 IPC。协议见
[RFC-sessbridge-channel-protocol-v1.md](https://github.com/larsonzh/sessbridge/blob/main/docs/RFC-sessbridge-channel-protocol-v1.md)。
（仓库：https://github.com/larsonzh/sessbridge ）

- 新通道：`%TEMP%\sessbridge`（可用 `SESSBRIDGE_CHANNEL_DIR` 覆盖）——
  `cmd_<pid>.json` / `res_<pid>.json` / `diag_<pid>.json`。
- 旧通道（whois 兼容）：`%TEMP%\vscode_chat_send_cmd_<pid>.json` 等。
- 模式：`visible`（聊天面板）、`silent`（vscode.lm）、`auto`。
- 多实例路由：仅处理 `cmd_<pid>` 中 `pid == process.ppid` 的实例文件。
- S0 能力探针：激活时写 `diag_<pid>.json` + `diag_<pid>-lm.json`。
- 聊天工具适配器：默认 `copilot`（`SESSBRIDGE_CHAT_TOOL` 可切换），
  新工具通过 `TOOL_ADAPTERS` 接入，客户端与协议不变。

安装：仓库根目录执行 `powershell -File installer\install.ps1 -Force`。

> VSIX 扩展和客户端脚本当前请到 GitHub 仓库获取：https://github.com/larsonzh/sessbridge

## English

File-based two-way IPC to Copilot Chat.  See
[RFC-sessbridge-channel-protocol-v1.md](https://github.com/larsonzh/sessbridge/blob/main/docs/RFC-sessbridge-channel-protocol-v1.md).
(Repo: https://github.com/larsonzh/sessbridge )

- New channel: `%TEMP%\sessbridge` (override `SESSBRIDGE_CHANNEL_DIR`) —
  `cmd_<pid>.json` / `res_<pid>.json` / `diag_<pid>.json`.
- Legacy channel (whois compat): `%TEMP%\vscode_chat_send_cmd_<pid>.json` etc.
- Modes: `visible` (chat panel), `silent` (vscode.lm), `auto`.
- Multi-instance routing: only handles `cmd_<pid>` where `pid == process.ppid`.
- S0 capability probe: writes `diag_<pid>.json` + `diag_<pid>-lm.json` on activate.
- Chat tool adapter: default `copilot` (switch via `SESSBRIDGE_CHAT_TOOL`);
  new tools plug in through `TOOL_ADAPTERS` — client and protocol unchanged.

Install: `powershell -File installer\install.ps1 -Force` from repo root.

> For now, get the VSIX extension and client scripts from the GitHub repo: https://github.com/larsonzh/sessbridge
