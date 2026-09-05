# SessionBridge（会话桥）使用指南

> English: [SESSBRIDGE_README_EN.md](SESSBRIDGE_README_EN.md)

通过纯 IPC 文件通道与 VS Code Copilot Chat 进行**会话级双向**交互：
投递消息、捕获 AI 回复（silent）、聊天面板可见投递（visible）、未来捕获人工回复（M2）。
不依赖任何 UI 自动化（pywinauto / AHK）。

权威协议：[RFC-sessbridge-channel-protocol-v1.md](RFC-sessbridge-channel-protocol-v1.md)

## 架构总览

```
外部客户端 (Python / PowerShell / sh / ProofRail agent)
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
| `client/ps/sessbridge.ps1` | PowerShell 兼容层（Windows，契约与 Python 一致） |
| `client/sh/sessbridge.sh` | **sh 客户端**（Linux/macOS/POSIX，纯 shell；兼容 PS 与 GNU 风格参数） |
| `pyproject.toml` | Python 客户端可安装包（pip install 后得到 `sessbridge` 命令） |
| `installer/install.ps1` / `uninstall.ps1` | Windows 一键安装/卸载扩展 |
| `installer/install.sh` / `uninstall.sh` | Linux/macOS（POSIX）安装/卸载扩展 |
| `installer/uninstall-legacy.ps1` / `.sh` | 移除旧 whois `vscode-chat-sender`（防双装冲突） |
| `tests/golden/*.json` + `tests/test_contract.py` | 黄金样例 + 契约测试 |
| `tools/enforce_encoding.py` | 编码/行尾规范门禁 |

## 安装

### 前提

- VS Code >= 1.82
- GitHub Copilot 扩展（或经 `SESSBRIDGE_CHAT_TOOL` 适配的其它聊天工具）

### Windows

```powershell
# 1. 安装扩展到 VS Code
powershell -NoProfile -ExecutionPolicy Bypass -File "installer/install.ps1" -Force

# 2. 重新加载 VS Code 窗口（Ctrl+Shift+P → Developer: Reload Window）
```

扩展代码修改后重新执行安装脚本并重载窗口即可。

### Python 客户端（可选，pip 安装）

```powershell
# 安装生成 sessbridge 命令（也支持直接从仓库调用 python client\sessbridge.py ...）
python -m pip install --no-deps .

# 使用
sessbridge send --message "hello"
```

### Linux / macOS（POSIX）

```sh
# 1. 安装扩展到 VS Code（默认 ~/.vscode/extensions）
sh installer/install.sh

# 自定义扩展目录（VSCodium / Cursor / 便携版等）
sh installer/install.sh --dir ~/.vscode-oss/extensions
VSCODE_EXTENSIONS_DIR=~/.cursor/extensions sh installer/install.sh

# 强制覆盖重装
sh installer/install.sh --force

# 2. 重载 VS Code：命令面板（Ctrl+Shift+P）→ Developer: Reload Window，或退出重开
#    （Linux 部分发行版也可用 xdg 快捷方式/重启窗口）

# 验证
code --list-extensions | grep -i sessbridge

# 卸载 / 移除旧 whois 扩展（防双装冲突）
sh installer/uninstall.sh [--dir <extensions-dir>]
sh installer/uninstall-legacy.sh
```

> PS1 与 SH 行为一致（`--force`/`--dir`；`VSCODE_EXTENSIONS_DIR` 对应 Windows 的
> `$env:USERPROFILE\.vscode\extensions` 固定路径，由 `.ps1` 内部处理）。

## 使用方法

### Python（主实现）

子命令：`send` / `wait` / `reply` / `discover`。

- `send`：投递新消息并等待回执（可带 `--conversation-id` 延续上下文）；
- `reply`：继续某个既有会话（`--conversation-id` **必填**；信封与 `send`+会话 ID 等价）；
- `wait`：等待其它进程已产生的回执（只读，不投递）；`discover`：列出可用 LM 模型。

通用参数（各子命令均支持）：

| 参数 | 说明 | 默认 |
|------|------|------|
| `--message` | 消息文本（`send`/`reply` 必填） | — |
| `--request-id` | 回执绑定 ID（自动 `sess-<uuid>`；重试复用同 ID 幂等） | 自动 |
| `--target-pid` | 目标 VS Code 主窗口 PID（0=自动探测） | 0 |
| `--channel-dir` | 通道目录覆盖（与 PS `-ChannelDir` 对齐） | 环境变量或 `%TEMP%\sessbridge` |
| `--timeout` | 等待回执秒数 | 30 |
| `--poll-interval` | 轮询间隔毫秒 | 200 |
| `--json-output` | 输出 JSON 回执（供脚本解析） | 关 |
| `--keep` | 读取回执后保留文件（事后分析/审计） | 关 |
| `--legacy` | 旧协议（whois 文件名/载荷，供 whois 过渡） | 关 |
| `--mode` | `visible` / `silent` / `auto` | visible |
| `--priority` | `normal`（排队）/ `high`（打断） | normal |
| `--auto-escalate` | normal 超时自动转 high 重试 | 关 |
| `--model` | 指定 LM 模型名称/ID（silent/auto） | 空（自动选择） |
| `--model-options` | JSON 模型选项（如 `{"thinking_mode":"deep"}`） | 无 |
| `--lm-response-timeout-ms` | 按请求覆盖扩展侧 LM 等待（1000–3600000） | 0（用扩展默认） |
| `--conversation-id` | 会话上下文 ID（`reply` 必填；`send` 可选，传入即激活多轮历史） | 空 |
| `--turn-id` | 回合号（可选；省略=按历史自动递增；0=显式新回合） | 省略（自动递增） |
| `--reset-history` | 显式重置并清空该会话历史（重新开始） | 关 |
| `--no-compress` | 关键轮次跳过 assistant 输出智能压缩 | 关 |

`wait` 额外支持 `--res-file <path>`（显式指定回执文件，高级）；`discover` 无需 `--message`。

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

# 自定义超时/轮询（快速冒烟 / 慢速长任务）
python client\sessbridge.py send --message "test" --timeout 10 --poll-interval 100
python client\sessbridge.py send --message "慢查询" --timeout 120

# 固定 request-id + 指定实例 + JSON（无人值守脚本）
python client\sessbridge.py send --message "状态" --request-id msg001 --target-pid 6288 --json-output

# 自定义通道目录（与 PS -ChannelDir 对齐）
python client\sessbridge.py send --message "x" --channel-dir "D:\temp\sb" --json-output

# 保留回执文件（事后分析）
python client\sessbridge.py send --message "test" --keep --json-output

# 模型选项（键取决于具体模型，如 DeepSeek thinking_mode）
python client\sessbridge.py send --message "x" --mode silent --model "DeepSeek V4 Flash" \
  --model-options '{"thinking_mode":"deep"}'

# 等待既有回执（另一进程已发出，这里读取；可指定文件）
python client\sessbridge.py wait --request-id msg001 --keep
python client\sessbridge.py wait --conversation-id conv-x --res-file "D:\tmp\res_4242.json"

# 带回合号继续会话（M2 语义，v1 透传）
python client\sessbridge.py reply --message "继续" --conversation-id conv-x --turn-id 1
```

### 静默会话历史（silent 多轮上下文，RFC §5.1）

未传 `--conversation-id` 时保持**无状态单轮**（旧行为）；传入非空
`--conversation-id` 后，扩展为该会话维护消息历史（`history_<conversationId>.json`），
每轮 `requests = 历史 + 当前消息`，AI 可引用先前轮次事实持续工作：

```powershell
# 第 1 轮：开始新会话（turnId 0），回执携带 history 健康度
python client\sessbridge.py send --message "第 1 轮任务简报" --mode silent `
  --conversation-id prfrail-phase-1 --turn-id 0 --json-output

# 第 2 轮：延续上下文（不必再给全量背景）
python client\sessbridge.py send --message "基于上一步继续" --mode silent `
  --conversation-id prfrail-phase-1 --turn-id 1 --json-output

# 某阶段结束：显式重置（清空历史并以当前消息为新锚点）
python client\sessbridge.py send --message "开始新阶段" --mode silent `
  --conversation-id prfrail-phase-1 --reset-history --no-compress --json-output
```

- 回执 `history` 字段（`totalTurns`/`inputTokensEst`/`isTruncated`/`evictedTurns`）
  供脚本判断上下文健康度；
- 关键交付轮次（diff/配置/代码）加 `--no-compress` 跳过智能截断；
- 历史默认保留 20 轮 / ~24K token / 单文件 ≤1MB，剔除保“头(锚点)+尾”、留痕并归档；
- 换 `--conversation-id` 即开全新会话（成本最低的“重置”）。

### PowerShell（兼容层，Windows）

参数集为 whois `Send-IpcChatMessage.ps1` 的**全集超集**（whois 参数全部保留，并新增
`ChannelDir` / `Legacy` / `ConversationId` / `TurnId`）：

| 参数 | 说明 | 默认 |
|------|------|------|
| `-Message` | 消息文本（Send 集合必填；`-DiscoverModels` 时无需） | — |
| `-RequestId` | 回执绑定 ID（自动 `sess-<uuid>`） | 自动 |
| `-JsonOutput` | 输出 JSON 回执 | 关 |
| `-KeepTempFiles` | 读取后保留回执文件 | 关 |
| `-TargetPid` | 目标实例 PID（0=自动探测） | 0 |
| `-Priority` | `normal` / `high` | normal |
| `-AutoEscalate` | normal 超时自动转 high 重试 | 关 |
| `-TimeoutSec` | 等待秒数（1–5400） | 30 |
| `-PollIntervalMs` | 轮询间隔毫秒（50–2000） | 200 |
| `-Mode` | `Silent` / `Visible` / `Auto` | Visible |
| `-Model` | 指定 LM 模型名称/ID | 空（自动选择） |
| `-ModelOptions` | hashtable 模型选项（如 `@{ thinking_mode = "deep" }`） | 无 |
| `-LmResponseTimeoutMs` | 按请求覆盖扩展侧 LM 等待（1000–3600000） | 0 |
| `-DiscoverModels` | 列出可用模型（Discover 集合，无需 `-Message`） | 关 |
| `-ChannelDir` | 通道目录覆盖 | `%TEMP%\sessbridge` |
| `-Legacy` | 旧协议（whois 文件名/载荷） | 关 |
| `-ConversationId` | 会话上下文 ID | 空 |
| `-TurnId` | 回合号（可选；省略/-1=按历史自动递增；0=显式首回合） | -1（自动递增） |
| `-ResetHistory` | 显式重置并清空该会话历史 | 关 |
| `-NoCompress` | 关键轮次跳过 assistant 输出智能压缩 | 关 |

```powershell
.\client\ps\sessbridge.ps1 -Message "你的消息"
.\client\ps\sessbridge.ps1 -Message "状态" -Mode Silent -Model "DeepSeek V4 Flash" -JsonOutput
.\client\ps\sessbridge.ps1 -Message "紧急" -Priority high
.\client\ps\sessbridge.ps1 -Message "x" -DiscoverModels
.\client\ps\sessbridge.ps1 -Message "x" -Legacy -JsonOutput

# 自定义超时/轮询（快速冒烟 / 慢速长任务）
.\client\ps\sessbridge.ps1 -Message "test" -TimeoutSec 10 -PollIntervalMs 100 -JsonOutput
.\client\ps\sessbridge.ps1 -Message "慢查询" -TimeoutSec 120

# 长任务：按请求覆盖扩展侧超时（无需重启 VS Code）
.\client\ps\sessbridge.ps1 -Message "长任务" -Mode Silent -TimeoutSec 120 -LmResponseTimeoutMs 180000 -JsonOutput

# 模型选项（哈希表）
.\client\ps\sessbridge.ps1 -Message "x" -Mode Silent -Model "DeepSeek V4 Flash" -ModelOptions @{ thinking_mode = "deep" }

# 保留回执文件（事后分析）
.\client\ps\sessbridge.ps1 -Message "test" -KeepTempFiles -JsonOutput

# 指定实例 / 自定义通道目录 / 旧协议
.\client\ps\sessbridge.ps1 -Message "hi" -TargetPid 6288
.\client\ps\sessbridge.ps1 -Message "hi" -ChannelDir "D:\temp\sb"
.\client\ps\sessbridge.ps1 -Message "hi" -Legacy

# 会话回合（-TurnId 0 显式首回合）
.\client\ps\sessbridge.ps1 -Message "继续" -ConversationId conv-x -TurnId 1
```

### sh 客户端（Linux / macOS / POSIX）

纯 POSIX shell 实现（`client/sh/sessbridge.sh`），**无需 Python / Node / jq**；
同时兼容 PowerShell 风格（`-Message`）与 GNU 风格（`--message`）参数，值大小写不敏感。

| 参数（PS 风格 / GNU 风格） | 说明 | 默认 |
|------|------|------|
| `-Message` / `--message` | 消息文本 | 空 |
| `-Mode` / `--mode` | `Silent` / `Visible` / `Auto`（大小写不敏感） | visible |
| `-Model` / `--model` | 指定 LM 模型名称/ID（silent/auto） | 空（自动选择） |
| `-RequestId` / `--request-id` | 回执绑定 ID（自动 `sess-<epoch>-<hex>`） | 自动 |
| `-TargetPid` / `--target-pid` | 目标实例 PID（0=自动探测） | 0 |
| `-ChannelDir` / `--channel-dir` | 通道目录覆盖 | `$TMPDIR/sessbridge` |
| `-TimeoutSec` / `--timeout` | 等待秒数 | 30 |
| `-PollIntervalMs` / `--poll-interval` | 轮询间隔毫秒 | 200 |
| `-KeepTempFiles` / `--keep` | 读取后保留回执文件 | 关 |
| `-JsonOutput` / `--json-output` | 输出 JSON 回执 | 关 |
| `-Pretty` / `--pretty` | 多行可读回执（Format-List 风格） | 关 |
| `-Legacy` / `--legacy` | 旧协议（whois 文件名/载荷） | 关 |
| `-Priority` / `--priority` | `normal` / `high` | normal |
| `-AutoEscalate` / `--auto-escalate` | normal 超时自动转 high 重试 | 关 |
| `-LmResponseTimeoutMs` / `--lm-response-timeout-ms` | 按请求覆盖扩展侧 LM 等待 | 0 |
| `-ConversationId` / `--conversation-id` | 会话上下文 ID | 空 |
| `-TurnId` / `--turn-id` | 回合号（可选；省略=按历史自动递增；0=显式首回合） | 省略（自动递增） |
| `-ResetHistory` / `--reset-history` | 显式重置并清空该会话历史 | 关 |
| `-NoCompress` / `--no-compress` | 关键轮次跳过 assistant 输出智能压缩 | 关 |
| `-DiscoverModels` / `--discover` / `-d` | 列出可用模型 | 关 |

- PID 解析顺序：`-TargetPid` → `$VSCODE_PID` → `pgrep` → `ps -W`（Git Bash）；
  无法解析时回退 legacy 共享路径（需配合 `-Legacy`）。
- `-h` / `--help` 显示帮助；退出码与 Python/PS 一致（0/1/2/3）。

```bash
# 最基本用法（visible：聊天面板可见）
sh client/sh/sessbridge.sh -Message "你的消息"

# Silent 模式 + 指定模型 + JSON（捕获 AI 响应）
sh client/sh/sessbridge.sh -Message "例行状态" -Mode Silent \
  -Model "DeepSeek V4 Flash Vision Exp" -JsonOutput

# 多行可读回执（等价 PS 的 ConvertFrom-Json | Format-List）
sh client/sh/sessbridge.sh -Message "状态" -Mode Silent \
  -Model "DeepSeek V4 Flash Vision Exp" -Pretty

# 列出可用 LM 模型
sh client/sh/sessbridge.sh -DiscoverModels

# 保留回执 / 指定实例 / 自定义通道目录 / 旧协议
sh client/sh/sessbridge.sh -Message "test" -KeepTempFiles -JsonOutput
sh client/sh/sessbridge.sh -Message "hi" -TargetPid 6288
sh client/sh/sessbridge.sh -Message "hi" -ChannelDir "/tmp/sb"
sh client/sh/sessbridge.sh -Message "hi" -Legacy

# 超时/轮询/优先级/自动升级
sh client/sh/sessbridge.sh -Message "test" -TimeoutSec 10 -PollIntervalMs 100
sh client/sh/sessbridge.sh -Message "紧急" -Priority high
sh client/sh/sessbridge.sh -Message "状态" -AutoEscalate

# 会话回合（-TurnId 0 显式首回合）
sh client/sh/sessbridge.sh -Message "继续" -ConversationId conv-x -TurnId 1
```

> Python / PowerShell / sh 三个客户端由同一契约（RFC + 黄金样例 + 契约测试）锁定，禁止行为漂移。

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
`discovery` / `discovery_failed` / `timeout`。另有 `modeUsed`（auto 实际路径）、`model`（silent 模型信息）。

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
