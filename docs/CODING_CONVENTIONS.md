# SessionBridge 编码与工程规范（Coding Conventions）

> 状态：2026-09-04 定稿。适用：本仓库所有提交文件的创建与维护；
> 与本规范冲突的旧文件按本规范迁移（一次性 `--fix` 即可）。

## 1. 编码格式 + 行尾序列（硬规则）

为保证跨平台使用（Windows / Linux / macOS、PowerShell 5.1 / Python / Node / Go），
所有**提交进仓库**的文件必须满足：

| 文件类型 | 编码 | 行尾 | 说明 |
|----------|------|------|------|
| Markdown（`.md`） | UTF-8 **with BOM** | **LF** | 含 `copilot-instructions.md`、本文档 |
| PowerShell（`.ps1`） | UTF-8 **with BOM** | **LF** | PS 5.1 读写兼容、中文注释稳定 |
| JSON（`.json`） | UTF-8 **with BOM** | **LF** | 纯数据/黄金样例/测试夹具 |
| JSON（例外：`extension/package.json`） | UTF-8 **without BOM** | **LF** | 严格 JSON 解析器/打包工具（npm/vsce）拒绝 BOM |
| 其它（`.py`/`.js`/`.go`/`.txt`/`.gitignore`/`LICENSE`…） | UTF-8 **without BOM** | **LF** | 代码与明文文本 |

理由：

- **BOM**：Windows 记事本/PS 5.1 用 BOM 判定 UTF-8；Markdown/PS/JSON 带 BOM 可避免
  PowerShell 5.1 `Get-Content` 乱码与编辑器误判 ANSI。
- **JSON 例外**：Node `JSON.parse`、npm、vsce、VS Code 扩展清单解析器对 BOM 敏感，
  `extension/package.json` 必须无 BOM。
- **LF**：统一 diff、避免 `git` 跨平台行尾告警与 shebang/脚本边界问题。

### 1.1 机械门禁

```powershell
# 检查（CI/提交前，违规 exit 1）
python tools\enforce_encoding.py

# 自动规范化（仅做编码/BOM/EOL 转换，不改变内容语义）
python tools\enforce_encoding.py --fix
```

注意事项：

- 规范化**不得改变 JSON 值、数组顺序或 operation 结构**——只做编码/行尾转换。
- 新建 Markdown/PS1/JSON 后先 `--fix`（或直接以 BOM+LF 保存）再提交。
- 例外清单必须同步维护在 `tools/enforce_encoding.py` 的 `EXCEPTIONS_NO_BOM`。

## 2. 仓库结构（勿随意移动）

```
extension/        VS Code 扩展（JS，无构建步骤；package.json 无 BOM）
client/
  sessbridge.py   Python CLI（send/wait/reply/discover，仅 stdlib）
  ps/              PowerShell 兼容层（Send-IpcChatMessage.ps1）
installer/        安装/卸载脚本
tests/            黄金样例 + 契约测试（python tests\test_contract.py）
tools/            工程工具（enforce_encoding.py 等）
docs/             协议/RFC/指南/排障/能力矩阵
```

## 3. 契约纪律

- 通道协议以 `docs/RFC-sessbridge-channel-protocol-v1.md` 为**单一权威**；
  客户端（Python/PS）与扩展行为由 `tests/golden/*.json` + `tests/test_contract.py` 锁定。
- **双实现防漂移**：Python 与 PowerShell 客户端必须保持同一契约；新增字段/行为需
  先更新 RFC → 黄金样例 → 契约测试，禁止只改一端。
- 退出码契约：`0` 成功 / `1` 本地传输失败 / `2` 扩展侧失败 / `3` 参数校验失败。
- `requestId` 回执绑定：写命令前先清同一 requestId 的陈旧结果（先删旧结果再写新命令）。
- PowerShell 5.1 兼容：脚本保持纯 ASCII 注释（或经确认的 UTF-8 BOM），
  禁止内联 `$(if (...) { ... } else { ... })` 子表达式（历史坑位）。
- 写 JSON 文件给 Node 解析时，必须用无 BOM 编码（`WriteAllText` + `UTF8Encoding($false)`
  或 Python `json.dump`）。

## 4. 聊天工具适配器（扩展侧接缝）

- 扩展当前默认适配 **Copilot Chat**（`SESSBRIDGE_CHAT_TOOL=copilot`），
  唯一依赖面是 `extension/extension.js` 中的 `TOOL_ADAPTERS`：
  - `panelCommands`：聊天面板命令 ID（open/focus/submit/queue/cancel/removePending/paste）
  - `hasLmApi()` / `selectModels()` / `sendLm()`：对话模型 API 封装
- 未来接入 **Continue 等其它聊天工具**时：
  1. 在 `TOOL_ADAPTERS` 增加对应 adapter（同样的 `toolKey/panelCommands/LM API 封装`）；
  2. 客户端与通道协议**不变**（协议与具体工具无关）；
  3. 更新能力矩阵与本规范，保留 `copilot` 为默认。
- 扩展不得直接散落硬编码 `workbench.action.chat.*`（历史实现遗留），
  新代码一律经 `runPanelCommand()`/适配器调用。

## 5. Git 纪律

- 默认推送到 `origin`；**gitee 仅是镜像**，未经用户同一轮显式要求**禁止**任何 gitee push。
- 未经用户同一轮显式授权，**禁止** `git commit` / `git push`。
- 提交信息风格：`<type>: <summary>`（chore/feat/fix/docs/test/build）。

## 6. 文档

- 根 `README.md`：快速开始与定位；`docs/SESSBRIDGE_README.md`：完整指南；
  `docs/SESSBRIDGE_TROUBLESHOOTING_CN.md`：快速排障清单。
- 能力矩阵（`docs/capability-matrix.md`）在 S0 探针后填写；`docs/DEV_PLAN.md` 跟踪里程碑。
