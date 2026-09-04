# SessionBridge（会话桥）使用指南

通过纯 IPC 文件通道与 VS Code Copilot Chat 进行**会话级双向**交互：
投递消息、捕获 AI 回复（silent）、聊天面板可见投递（visible）、未来捕获人工回复（M2）。
不依赖任何 UI 自动化（pywinauto / AHK）。

权威协议：[RFC-sessbridge-channel-protocol-v1.md](RFC-sessbridge-channel-protocol-v1.md)

## 架构总览

```
外部客户端 (PowerShell / Python / ProofRail agent)
    │  写入 <channel_dir>/cmd_<targetPid>.json      （outbound 消息，v1 信封）
    │  读取 <channel_dir>/res_<targetPid>.json      （回执 / 回复）
    ▼
SessionBridge 扩展（VS Code，轮询 <channel_dir>）
    │  仅处理匹配自身 process.ppid 的命令文件
    │  分发 mode：
    │    visible → 聊天面板投递 + 会话事件捕获（人工/AI 回复，M2）
    │    silent  → LM API 直达 → 捕获 AI 响应（零 UI）
    │    auto    → 先 silent，失败回退 visible
    ▼
VS Code Copilot Chat（会话、上下文、人工审核/确认）
```

- 通道目录默认：`%TEMP%\sessbridge`（Windows）/ `$TMPDIR/sessbridge`（POSIX）；
  环境变量 `SESSBRIDGE_CHANNEL_DIR` 覆盖（**调用方与扩展必须一致**）。
- 多实例路由：每个 VS Code 实例只处理 `cmd_<pid>` 中 `pid == process.ppid` 的实例专用文件；
  调用方通过 `--target-pid` / `-TargetPid` 指定目标实例。

## 仓库文件说明

| 文件 | 用途 |
|------|------|
| `extension/package.json` / `extension.js` | VS Code 扩展清单与逻辑（聊天工具适配器） |
| `client/sessbridge.py` | **主实现**：Python 3 CLI（send/wait/reply/discover） |
| `client/ps/Send-IpcChatMessage.ps1` | PowerShell 兼容层（Windows，契约与 Python 一致） |
| `installer/install.ps1` / `uninstall.ps1` | 一键安装/卸载扩展 |
| `tests/golden/*.json` + `tests/test_contract.py` | 黄金样例 + 契约测试 |
| `tools/enforce_encoding.py` | 编码/行尾规范门禁 |

## 安装

### 前提

- VS Code >= 1.82
- GitHub Copilot 扩展（或经 `SESSBRIDGE_CHAT_TOOL` 适配的其它聊天工具）

### 步骤

```powershell
# 1. 安装扩展到 VS Code
powershell -NoProfile -ExecutionPolicy Bypass -File "installer/install.ps1" -Force

# 2. 重新加载 VS Code 窗口（Ctrl+Shift+P → Developer: Reload Window）
```

扩展代码修改后重新执行安装脚本并重载窗口即可。

## 使用方法

### Python（主实现）

```powershell
# 最基本用法（visible：聊天面板可见）
python client\sessbridge.py send --message "你的消息"

# request-id（追踪/回执绑定）
python client\sessbridge.py send --message "你好" --request-id msg001

# 高优先级——打断当前 AI 工作（事件驱动票）
python client\sessbridge.py send --message "紧急事件" --priority high

# 正常优先级——排队等待（状态票），超时自动升级 high
python client\sessbridge.py send --message "状态报告" --priority normal --auto-escalate

# JSON 输出（供脚本解析）
python client\sessbridge.py send --message "test" --json-output

# Silent 模式——LM API 直达，零 UI，捕获 AI 响应
python client\sessbridge.py send --message "例行状态" --mode silent --timeout 90

# Silent + 指定模型 + 思考模式 + 按请求覆盖扩展侧超时
python client\sessbridge.py send --message "长任务" --mode silent \
  --model "DeepSeek V4 Flash" --model-options '{"thinking_mode":"deep"}' \
  --lm-response-timeout-ms 180000 --json-output

# Auto 模式——先 silent，失败回退 visible
python client\sessbridge.py send --message "状态" --mode auto

# 继续会话（conversationId/turnId，M2 语义）
python client\sessbridge.py reply --message "继续" --conversation-id conv-x

# 等待既有回执（其它进程已发出后，这里读取）
python client\sessbridge.py wait --request-id msg001

# 列出可用 LM 模型
python client\sessbridge.py discover

# 旧协议兼容（whois 文件名/载荷，供 whois 流程过渡）
python client\sessbridge.py send --message "hello" --legacy
```

### PowerShell（兼容层，Windows）

```powershell
.\client\ps\Send-IpcChatMessage.ps1 -Message "你的消息"
.\client\ps\Send-IpcChatMessage.ps1 -Message "状态" -Mode Silent -Model "DeepSeek V4 Flash" -JsonOutput
.\client\ps\Send-IpcChatMessage.ps1 -Message "紧急" -Priority high
.\client\ps\Send-IpcChatMessage.ps1 -Message "x" -DiscoverModels
.\client\ps\Send-IpcChatMessage.ps1 -Message "x" -Legacy -JsonOutput
```

> Python 与 PowerShell 行为由同一契约测试锁定，禁止漂移。

## 通信协议

### 文件命名规则（新协议，通道目录内）

```
命令文件:  <channel_dir>\cmd_<targetPid>.json
结果文件:  <channel_dir>\res_<targetPid>.json
诊断文件:  <channel_dir>\diag_<pid>.json / diag_<pid>-lm.json（扩展激活探针）
```

### 旧协议兼容（whois，始终在系统临时目录）

```
命令文件:  %TEMP%\vscode_chat_send_cmd_<pid>.json（或共享 vscode_chat_send_cmd.json）
结果文件:  %TEMP%\vscode_chat_send_res_<pid>.json（或共享 vscode_chat_send_result.json）
```

### 命令文件（输入，v1 信封）

```json
{
  "schemaVersion": "1",
  "requestId": "sess-<uuid>",
  "mode": "visible",
  "priority": "normal",
  "message": "要发送的消息",
  "targetPid": 12345,
  "timeoutMs": 30000,
  "lmResponseTimeoutMs": 180000,
  "conversationId": "可选会话上下文",
  "turnId": 0,
  "createdAt": "2026-09-04T00:00:00Z",
  "legacy": false
}
```

| 字段 | 说明 |
|------|------|
| `requestId` | 回执绑定 ID（客户端生成 `sess-` 前缀；重复请求复用同 ID 幂等） |
| `mode` | `visible` / `silent` / `auto` |
| `priority` | `normal`（排队）/ `high`（打断） |
| `timeoutMs` | 调用方等待回执上限（客户端生成） |
| `lmResponseTimeoutMs` | 可选，按请求覆盖扩展侧 LM 响应等待（仅本次） |
| `conversationId` / `turnId` | 会话回合标识（M2 语义，v1 透传回显） |
| `discover` | 可选，`true` 时列出可用模型（不发送消息） |

### 结果文件（输出，v1 回执）

```json
{
  "schemaVersion": "1",
  "requestId": "sess-<same>",
  "status": "ok",
  "mode": "silent",
  "response": "AI 或人工回复文本",
  "humanReply": "人工回复（visible 双向回合时捕获，M2；v1 为空）",
  "conversationId": "",
  "turnId": 1,
  "error": "",
  "polledMs": 0,
  "extensionVersion": "0.1.0",
  "finishedAt": "2026-09-04T00:00:05Z"
}
```

`status` 值（M1）：`ok` / `lm_api_unavailable` / `extension_error` / `no_message` /
`discovery` / `discovery_failed`。另有 `modeUsed`（auto 实际路径）、`model`（silent 模型信息）。

### 可能的失败原因 / 退出码

| 原因 | 含义 | 客户端退出码 |
|------|------|-------------|
| `poll_timeout` | 扩展未在超时内响应 | 1 |
| `write_cmd_failed:*` | 调用方写命令文件失败（本地） | 1 |
| `lm_api_unavailable` | Silent 模式 LM API 不可用 | 2 |
| `extension_error` / `no_message` | 扩展侧失败 | 2 |
| 参数校验失败（空消息等） | 客户端本地校验 | 3 |

## 模型选择策略（silent/auto）

由扩展 `pickModel()` 控制：

0. 调用方指定（`model` 字段，按名称/ID 匹配）
1. `Auto`（Copilot 自动路由，通常与聊天面板一致）
2. `DeepSeek V4 Flash`（当前常用默认）
3. 第一个可用模型（兜底）

## 长耗时回复处理

- **双超时**：客户端轮询超时 `--timeout`（默认 30s，可调）+ 扩展侧 LM 响应等待
  `lmResponseTimeoutMs`（默认 60000ms，可按请求覆盖，无需重启 VS Code）。
- **关键约束**：扩展宿主进程的 `process.env` 与集成终端环境**互相独立**——
  在终端里 `$env:SESSBRIDGE_LM_RESPONSE_TIMEOUT_MS=...` 对扩展**不可见**；
  需要全局生效请用系统/用户环境变量后重启 VS Code，或按请求覆盖。
- Visible 模式粘贴+提交后立即返回（不阻塞、无 `response`）。

## 三种模式对比

| 模式 | 能否拿到 `response` | 调用方阻塞 | 适用场景 |
|------|--------------------|-----------|---------|
| `silent` + `--lm-response-timeout-ms` | ✅ 完整回复 | = AI 生成时长 | 需要回复内容 |
| `visible` | ❌（M2 前无回复） | 极短 | 只投递/人工交互 |
| `auto` | ⚠️ 视路径 | 视路径 | 兼容/便利 |

## 工作原理

1. 扩展在 VS Code 启动时激活（`onStartupFinished`），创建通道目录并写能力探针
   （`diag_<pid>.json` / `diag_<pid>-lm.json`，供 S0 能力矩阵）。
2. 每 `SESSBRIDGE_POLL_MS`（默认 300ms）轮询：`cmd_<ppid>.json`（新协议）→
   旧 PID 作用域 → 旧共享文件。
3. 读到命令文件：删除（at-most-once），按 `mode` 分发：
   - `visible`：`removePending` →（`high` 先 `cancel`）→ `open` → 剪贴板 → `focusInput`
     → 粘贴 → `queueMessage`/`submit`；成功后立即写回执。
   - `silent`：`vscode.lm`（经适配器）直达，收集 `response.text`，写完回执。
   - `auto`：先 silent，失败回退 visible（回执标注 `modeUsed`）。
4. 回执经临时文件 + 原子重命名写入；调用方轮询读取（读完删除，`--keep` 保留）。
5. 陈旧文件（>24h）由扩展定期清理并写诊断留痕。

## 聊天工具适配（未来 Continue 等）

- 扩展只通过 `TOOL_ADAPTERS`（`extension.js`）接触具体聊天工具，默认 `copilot`
  （`SESSBRIDGE_CHAT_TOOL` 可切换，未配置回退 copilot）。
- 接入新工具：新增 adapter（面板命令 ID + LM API 封装），客户端与协议不变。
- 详见 [CODING_CONVENTIONS.md](CODING_CONVENTIONS.md) §4。

## 调试

```powershell
# 通道目录（默认）
Get-ChildItem "$env:TEMP\sessbridge"

# 查看能力探针（S0）
Get-Content "$env:TEMP\sessbridge\diag_$env:VSCODE_PID.json"

# 保留结果文件事后分析
python client\sessbridge.py send --message test --keep --json-output

# 清理通道文件
Remove-Item "$env:TEMP\sessbridge\cmd_*.json","$env:TEMP\sessbridge\res_*.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:TEMP\vscode_chat_send_*.json" -Force -ErrorAction SilentlyContinue
```

## 常见问题

### Q1: 如何把消息发到指定的 VS Code 实例？

`Get-Process -Name Code | Where-Object MainWindowTitle` 只看主窗口（过滤子进程）。
用 `--target-pid <Id>` / `-TargetPid <Id>` 精确投递。
同进程内多窗口（同一 PID）无法在进程层区分——消息进入该进程的活跃聊天，
需要严格区分请用不同 VS Code Profile/版本。

### Q2: 如何避免“保留/移除”弹窗？

两种优先级发送前都先 `removeAllPendingRequests` 清空队列：
`normal` → `queueMessage`；`high` → 清队列 + `cancel` + `submit`。
`--auto-escalate` 仍保底：normal 超时自动转 high 重试。

### Q3: 消息中换行与引号？

Python：`--message "第一行\n第二行"`（JSON 序列化保留 `\n`）。
PowerShell：here-string 或单引号包裹外层；JSON 中 `\n` 会被扩展解析为换行。
建议用 `--json-output`/`-JsonOutput` 验证实际内容。

### Q4: Silent 模式拿到的是“模型原始回复”还是“工具执行过程”？

一次请求一次响应：AI 中间操作（读文件/改代码/调终端）不会单独回传；
扩展持续收集 chunk 直到生成完成一次性写入。超时截断会标记
`aiResponseTruncated` /（legacy）`ai_response_truncated`。
