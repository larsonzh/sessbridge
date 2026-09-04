# Copilot Instructions for sessbridge（会话桥）

面向：在 VS Code 中协助维护本仓库的 AI 代理。请先掌握结构、契约与规范，避免破坏协议。

## 定位与权威
- 产品：SessionBridge（会话桥）——VS Code Copilot Chat 与外部自动化的**会话级双向**文件/IPC 桥。
- **协议单一权威**：`docs/RFC-sessbridge-channel-protocol-v1.md`；实现细节以
  `docs/SESSBRIDGE_README.md`（指南）、`docs/SESSBRIDGE_TROUBLESHOOTING_CN.md`（排障）为准。
- ProofRail（证轨）只消费 `silent` 消息层 + 文件队列；`visible` 人工交互是 SessionBridge 产品能力，
  **不要**把 visible 语义写进 ProofRail 正式协议。

## 结构速览
- `extension/extension.js`：VS Code 扩展（JS 无构建）。轮询通道目录；新协议 `cmd_<pid>.json`/`res_<pid>.json`/`diag_<pid>.json`；旧协议 whois 文件名（始终 `%TEMP%`）。
- `client/sessbridge.py`：Python 3 CLI（仅 stdlib）`send|wait|reply|discover`，退出码 0/1/2/3。
- `client/ps/Send-IpcChatMessage.ps1`：PowerShell 兼容层，与 Python 同一契约（禁止漂移）。
- `installer/`：`install.ps1` / `uninstall.ps1` / `uninstall-legacy.ps1`。
- `tests/`：`golden/*.json` 黄金样例 + `test_contract.py` 契约测试（mock 扩展）。
- `tools/enforce_encoding.py`：编码/行尾门禁。

## 契约纪律（不要破坏）
- 改动协议 → 先改 RFC → 黄金样例 → 契约测试 → 客户端（Python/PS 同步改）。
- `requestId` 回执绑定：先删同 ID 陈旧结果，再写命令（防假 `poll_timeout`）。
- 结果文件原子写（临时文件 + rename）；独占写。
- 通道目录默认 `%TEMP%\sessbridge`；`SESSBRIDGE_CHANNEL_DIR` 覆盖（调用方与扩展必须一致）。
- 扩展只处理 `cmd_<pid>` 中 `pid == process.ppid` 的实例文件；旧共享文件兼容。
- PowerShell 5.1：禁止内联 `$(if (...) { } else { })`；写 JSON 给 Node 必须无 BOM
  （`WriteAllText` + `UTF8Encoding($false)`）；脚本保持可解析。

## 聊天工具适配器（未来 Continue 等）
- 扩展只通过 `TOOL_ADAPTERS`（`extension.js`）接触具体聊天工具；默认 `copilot`
  （`SESSBRIDGE_CHAT_TOOL` 覆盖，未配置回退 copilot）。
- 新增工具 = 新增 adapter（面板命令 ID + `hasLmApi/selectModels/sendLm`）；客户端与协议**不变**。
- 新代码禁止直接硬编码 `workbench.action.chat.*`，一律走 `runPanelCommand()`/适配器。

## 编码 + 行尾（硬规则，见 docs/CODING_CONVENTIONS.md）
- `.md` / `.ps1` / `.json`：UTF-8 **with BOM** + **LF**；其中 `extension/package.json` 例外：
  UTF-8 **without BOM** + LF（严格 JSON 解析器/打包工具拒绝 BOM）。
- 其它（`.py`/`.js`/`.go`/`.txt`/`.gitignore`/`LICENSE`）：UTF-8 **without BOM** + LF。
- 门禁：`python tools\enforce_encoding.py`（违规 exit 1）；`--fix` 只做编码/EOL 转换，
  **不得改变 JSON 值、数组顺序或语义**。
## 临时文件
- 临时/一次性文件放仓库根 `tmp/`（已 gitignore，仅 `tmp/.gitkeep` 保留目录）；
  **用完立即清除**，不得长期遗留。
## 测试与验证
- 契约测试：`python tests\test_contract.py`（纯 stdlib，无需 VS Code）。
- 语法检查：`node --check extension\extension.js`；PS 用 Parser::ParseFile。
- 修改扩展/客户端后必须重跑以上；扩展侧真实行为需在 VS Code 实机验证（S0 探针）。

## Git 纪律
- 默认只推 `origin`；**gitee 仅镜像备份**，未经用户同一轮显式要求禁止任何 gitee push。
- 未经用户同一轮显式授权，禁止 `git commit` / `git push`。
