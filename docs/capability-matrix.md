# SessionBridge 能力矩阵（Capability Matrix）

> English: [capability-matrix_EN.md](capability-matrix_EN.md)

> 状态：**S0 已完成**（2026-09-04，探针 `diag_28012.json` / `diag_28012-lm.json`；扩展 0.1.0）。

## 1. 环境

| 项 | 值 |
|---|---|
| 测试日期 | 2026-09-04 |
| VS Code 版本 | 1.136.1（x64；commit a44adf7f53e0） |
| Copilot 扩展版本 | 由 `vscode.lm`/`vscode.chat` 提供（扩展 ID 未在 `--list-extensions` 显式列出，LM 提供方经 `copilot`/`deepseek` vendor 呈现） |
| LM 通道 / 模型 | 34 个模型（vendor `copilot` 31 + vendor `deepseek` 3）：含 Auto、GPT-5.4/5.5/5.6、Claude Opus/Sonnet 5、Gemini 3.x、Grok 4.x、Kimi、MAI-Code、**DeepSeek V4 Flash / V4 Pro / V4 Flash Vision Exp** |
| 操作系统 | Windows |
| 已装相关扩展 | `larsonzh.sessbridge`（本次 S0）、`larsonzh.vscode-chat-sender`（旧扩展，正式使用前需卸载） |

## 2. API 可用性（探针实测）

| API | 可用 | 备注 |
|---|---|---|
| `vscode.chat` 命名空间 | ✅ | `chatKeys` 共 35 项（参与者/会话项/自定义代理/钩子等） |
| `vscode.chat.sendRequest` | ❌ | 不存在 |
| `vscode.chat.createChatParticipant` | ✅ | M2 人工回复**受控通道**依赖此项 |
| `vscode.chat.requestHandler` | ❌ | 不存在（旧 API 已移除）——全量捕获不可行 |
| `vscode.lm.selectChatModels` | ✅ | `modelCount=34` |
| `vscode.lm` 模型列表（数量/名称） | ✅ | 34 个（含 DeepSeek V4 Flash → silent 默认模型命中） |

## 3. 模式能力结论（S0 已冻结；端到端实测 2026-09-04）

| 模式 | 投递 | 捕获 AI 响应 | 捕获人工回复 | 结论 |
|---|---|---|---|---|
| `visible` | ✅ 面板可见（剪贴板+面板命令） | —（聊天面板） | ⚠️ 受限（见下） | **投递可用；人工回复走受控通道** |
| `silent` | ✅ 零 UI | ✅ `response`（LM API 直达） | — | **✅ 端到端实测 PASS**（`Auto`/copilot 模型：status=ok、modeUsed=silent、完整 response） |
| `auto` | ✅ silent→visible 回退 | ✅ 视路径 | ⚠️ 同 visible | **可用** |

**silent 端到端实测（2026-09-04，VS Code 1.136.1，扩展 0.1.0）**：
- ✅ `Auto`（vendor `copilot`）：`sendRequest` 正常返回，回执 `status:ok` + `modeUsed:silent` + 完整 `response`，链路全程可用。
- ✅ `DeepSeek V4 Flash`（vendor `deepseek`，经 `vizards.deepseek-v4-for-copilot` 通道）：重载后实测返回 `S0-OK`，回执 `status:ok` + `modeUsed:silent`，requestId `s0-deepseek-4`，目标 PID `28012`。
- **运行时保护**：`sendViaLmApi` 已为模型枚举、`sendRequest` 和流式收集增加超时保护，共用 `lmResponseTimeoutMs` 预算；若提供方再次挂起，将写显式回执（新协议 `status:"timeout"` / legacy `reason:"lm_api_unavailable"` + detail），不再让调用方盲等。

**M2 人工回复捕获结论（2026-09-04）**：
- `requestHandler` 不可用，`sendRequest` 不是 `vscode.chat` API → **无法全量静默捕获**聊天回复；不采用（也不得退化为 GUI 自动化）。
- `createChatParticipant` 可用 → M2 采用**受控回复通道**：注册 `sessbridge.review` participant，人工以 `@sessbridge.review <回复>` 触发，participant handler 把回复写入 `res_<pid>.json` 的 `humanReply`（RFC §5 允许的“受控回执文件补充”降级路径）。

**§5.1 静默会话历史端到端实测（2026-09-05，VS Code 1.136.1，扩展 0.1.0，`Auto`/copilot 模型）**：
- 会话 `s0-smoke-001` 三轮全过：① 注入标记 `SESS-SMOKE-42`（turnId 0）；② 追问“刚才的标记”→ 回复 `SESS-SMOKE-42`（第 2 轮引用第 1 轮事实）；③ `--reset-history` 后注入 `PHASE-2-OK` → 历史重置（`totalTurns` 回到 1）。
- 回执 `history` 健康度正确：turn1 `{totalTurns:1, inputTokensEst:17}`、turn2 `{totalTurns:2, inputTokensEst:27}`、reset 后 `{totalTurns:1}`；`isTruncated:false`。
- 磁盘持久化：`history_s0-smoke-001.json` 结构正确（`schemaVersion=1`，messages 含 `role/requestId/turnId/createdAt`）；reset 后文件回到 `turnId=1 / 2 条消息`。
- **结论：§5.1 静默会话历史端到端实测 ✅ PASS**（多轮上下文、健康度回显、显式重置均符合 RFC 与黄金样例）。

## 4. 降级路线（已确认）

- 保持“投递 + 轮询回执”单向语义（M1 现状）：`visible` 投递后即时回执，`humanReply` 留空。
- 人工回复以**受控 participant 通道**补充（`humanReply` 字段），由人工 `@sessbridge.review` 写入；记录于 RFC §5 开放问题 1。
- 不使用 GUI 自动化（AHK/键盘模拟/剪贴板注入/窗口焦点控制）。
- **DeepSeek 通道**：本次 S0 silent 直调 PASS；仍保留超时显式回执和 `auto` 模式（silent 失败→visible 回退）作为提供方异常时的兜底。
