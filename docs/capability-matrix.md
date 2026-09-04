# SessionBridge 能力矩阵（Capability Matrix）

> 状态：**待填写**（S0 spike 完成后更新，见 [S0-CAPABILITY-SPIKE.md](S0-CAPABILITY-SPIKE.md)）。

## 1. 环境

| 项 | 值 |
|---|---|
| 测试日期 | 2026-09-04 |
| VS Code 版本 | （待填，探针 `vscodeVersion`） |
| Copilot 扩展版本 | （待填） |
| LM 通道 / 模型 | （待填，如 DeepSeek V4 Flash / GPT-5.5） |
| 操作系统 | Windows |

## 2. API 可用性

| API | 可用 | 备注 |
|---|---|---|
| `vscode.chat` 命名空间 | ☐ | `diag_*.json` → `hasChatNamespace` |
| `vscode.chat.sendRequest` | ☐ | |
| `vscode.chat.createChatParticipant` | ☐ | 可用于捕获/传递人工回复 |
| `vscode.chat.requestHandler` | ☐ | |
| `vscode.lm.selectChatModels` | ☐ | silent 模式依赖 |
| `vscode.lm` 模型列表（数量/名称） | ☐ | `diag_<pid>-lm.json` |

## 3. 模式能力结论（S0 后冻结）

| 模式 | 投递 | 捕获 AI 响应 | 捕获人工回复 | 结论 |
|---|---|---|---|---|
| `visible` | ☐ 面板可见 | —（聊天面板） | ☐ | 待定 |
| `silent` | ☐ 零 UI | ☐ `response` | — | 待定 |
| `auto` | ☐ silent→visible 回退 | ☐ | ☐ | 待定 |

## 4. 降级路线（若受限）

- 保持“投递 + 轮询回执”单向语义（M1 现状）。
- 人工回复以受控回执文件补充（`humanReply` 字段），由人工/外部写入；
  记录于 RFC §5 开放问题 1。
- 不使用 GUI 自动化（AHK/键盘模拟/剪贴板注入/窗口焦点控制）。
