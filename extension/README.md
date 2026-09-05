# SessionBridge extension / 扩展（VS Code）

[English](#english) · [简体中文](#简体中文)

## English

File-based two-way IPC to Copilot Chat.  See the
[user guide](https://github.com/larsonzh/sessbridge/blob/main/docs/SESSBRIDGE_README_EN.md)
and the
[RFC-sessbridge-channel-protocol-v1_EN.md](https://github.com/larsonzh/sessbridge/blob/main/docs/RFC-sessbridge-channel-protocol-v1_EN.md).
(Repo: https://github.com/larsonzh/sessbridge )

- New channel: `%TEMP%\sessbridge` (override `SESSBRIDGE_CHANNEL_DIR`) —
  `cmd_<pid>.json` / `res_<pid>.json` / `diag_<pid>.json`.
- Legacy channel (whois compat): `%TEMP%\vscode_chat_send_cmd_<pid>.json` etc.
- Modes: `visible` (chat panel), `silent` (vscode.lm), `auto`.
- Silent conversation history (RFC §5.1): per-`conversationId` multi-turn
  context (`history_<id>.json`, head+tail eviction, receipt `history` metrics;
  empty id stays stateless).
- Multi-instance routing: only handles `cmd_<pid>` where `pid == process.ppid`.
- S0 capability probe: writes `diag_<pid>.json` + `diag_<pid>-lm.json` on activate.
- Chat tool adapter: default `copilot` (switch via `SESSBRIDGE_CHAT_TOOL`);
  new tools plug in through `TOOL_ADAPTERS` — client and protocol unchanged.

Install: `powershell -File installer\install.ps1 -Force` from repo root.

> For now, get the VSIX extension and client scripts from the GitHub repo: https://github.com/larsonzh/sessbridge

---

## 简体中文

基于文件通道的 VS Code Copilot Chat 双向 IPC。使用指南见
[SESSBRIDGE_README.md](https://github.com/larsonzh/sessbridge/blob/main/docs/SESSBRIDGE_README.md)，
协议见
[RFC-sessbridge-channel-protocol-v1.md](https://github.com/larsonzh/sessbridge/blob/main/docs/RFC-sessbridge-channel-protocol-v1.md)。
（仓库：https://github.com/larsonzh/sessbridge ）

- 新通道：`%TEMP%\sessbridge`（可用 `SESSBRIDGE_CHANNEL_DIR` 覆盖）——
  `cmd_<pid>.json` / `res_<pid>.json` / `diag_<pid>.json`。
- 旧通道（whois 兼容）：`%TEMP%\vscode_chat_send_cmd_<pid>.json` 等。
- 模式：`visible`（聊天面板）、`silent`（vscode.lm）、`auto`。
- 静默会话历史（RFC §5.1）：按 `conversationId` 维护多轮上下文
  （`history_<id>.json`，head+tail 剔除、回执 `history` 健康度；空 id 保持无状态）。
- 多实例路由：仅处理 `cmd_<pid>` 中 `pid == process.ppid` 的实例文件。
- S0 能力探针：激活时写 `diag_<pid>.json` + `diag_<pid>-lm.json`。
- 聊天工具适配器：默认 `copilot`（`SESSBRIDGE_CHAT_TOOL` 可切换），
  新工具通过 `TOOL_ADAPTERS` 接入，客户端与协议不变。

安装：仓库根目录执行 `powershell -File installer\install.ps1 -Force`。

> VSIX 扩展和客户端脚本当前请到 GitHub 仓库获取：https://github.com/larsonzh/sessbridge
