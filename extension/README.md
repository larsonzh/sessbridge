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

### Enable the experimental API (required for `@sbr-review`)

This extension uses the proposed API `chatParticipantAdditions` for the controlled
human-reply channel (RFC §5.2, mentioned as `@sbr-review` in the chat panel).
Color core features (`visible`/`silent`/`auto` delivery) work without it, but
the participant will not appear until you enable the proposed API:

1. Install the extension (Marketplace or VSIX) and reload the window.
2. **Option A — command line (one-time):** quit VS Code, then start it with:
   ```
   code --enable-proposed-api=larsonzh.sessbridge
   ```
3. **Option B — persistent setting:**
   1. Open the Command Palette (`Ctrl+Shift+P`).
   2. Run **Preferences: Configure Runtime Arguments** (首选项: 配置运行时参数).
   3. In the opened `argv.json`, add (keep the existing fields):
      ```json
      {
        "enable-proposed-api": ["larsonzh.sessbridge"]
      }
      ```
   4. Save and restart VS Code entirely (quit and reopen, not just Reload Window).

After either option, type `@sbr-review` in the chat panel — the participant
`SessionBridge Review` should appear in the mention list.

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

### 启用实验性 API（`@sbr-review` 必需）

本扩展的受控人工回复通道（RFC §5.2，面板中通过 `@sbr-review` 提及）使用了
proposed API `chatParticipantAdditions`。核心投递功能（`visible`/`silent`/`auto`）
**不需要**启用即可使用，但参与者（participant）只有在启用实验性 API 后才会出现：

1. 安装扩展（Marketplace 或 VSIX）并重载窗口。
2. **方式 A — 命令行（一次性）：** 完全退出 VS Code，然后用如下命令重新启动：
   ```
   code --enable-proposed-api=larsonzh.sessbridge
   ```
3. **方式 B — 持久设置（推荐）：**
   1. 打开命令面板（`Ctrl+Shift+P`）。
   2. 执行 **首选项: 配置运行时参数**（Preferences: Configure Runtime Arguments）。
   3. 在打开的 `argv.json` 中新增（保留原有字段）：
      ```json
      {
        "enable-proposed-api": ["larsonzh.sessbridge"]
      }
      ```
   4. 保存后**完全退出并重启** VS Code（不是“重载窗口”）。

完成任一方式后，在聊天面板输入 `@sbr-review` —— 提及列表应出现
“SessionBridge Review”参与者。
