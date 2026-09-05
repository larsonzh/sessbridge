# SessionBridge client

[English](#english) · [简体中文](#简体中文)

## English

### Python 3 client (primary, stdlib only)

#### Install (optional, pip)

```powershell
# Install from the repository (creates the `sessbridge` command)
python -m pip install --no-deps .

# Then use it directly
sessbridge send --message "hello"
```

You can also run it directly from the repository without installing:
`python client\sessbridge.py send --message "hello"`.

#### Usage

```powershell
# Deliver a message and wait for a receipt (default visible, appears in the chat panel)
python client\sessbridge.py send --message "hello"

# Silent: LM API direct, captures the AI response
python client\sessbridge.py send --message "status" --mode silent --model "DeepSeek V4 Flash"

# Auto: silent first, fall back to visible
python client\sessbridge.py send --message "status" --mode auto

# List available LM models
python client\sessbridge.py discover

# Continue a conversation (conversationId context)
python client\sessbridge.py reply --message "继续" --conversation-id conv-x

# Wait for an existing receipt (e.g. another process already sent it)
python client\sessbridge.py wait --request-id sess-xxxx

# Legacy protocol compatibility (whois file names/payload)
python client\sessbridge.py send --message "hello" --legacy

# JSON output / target instance / custom channel directory
python client\sessbridge.py send --message "x" --json-output --target-pid 12345
python client\sessbridge.py send --message "x" --channel-dir "D:\temp\sb"
```

Exit codes: `0` success; `1` local transport failure; `2` extension-side failure;
`3` validation failure.

### sh client (Linux / macOS / POSIX, no Python required)

`client/sh/sessbridge.sh` is a **pure POSIX shell implementation** (only `sh` +
standard tools, no Python / Node / jq) that shares the same contract as the
Python primary client and the PowerShell compat layer:

```sh
# Deliver a message (default visible)
sh client/sh/sessbridge.sh send --message "hello"

# Silent: LM API direct, captures the AI response
sh client/sh/sessbridge.sh send --message "status" --mode silent --model "DeepSeek V4 Flash Vision Exp"

# List available LM models
sh client/sh/sessbridge.sh discover

# Human-readable output / multiline readable receipt (Format-List style) / JSON output
sh client/sh/sessbridge.sh send --message "hello"
sh client/sh/sessbridge.sh send --message "x" --pretty
sh client/sh/sessbridge.sh send --message "x" --json-output --keep

# Help
sh client/sh/sessbridge.sh --help
```

Supports `--mode/--model/--request-id/--target-pid/--channel-dir/--timeout/
--poll-interval/--keep/--json-output/--legacy/--priority/--auto-escalate/
--lm-response-timeout-ms/--conversation-id/--turn-id/--discover`.
Also accepts **PowerShell-style parameters**: `-Message/-Mode/-Model/-RequestId/
-TargetPid/-ChannelDir/-TimeoutSec/-PollIntervalMs/-KeepTempFiles/
-JsonOutput/-Legacy/-Priority/-AutoEscalate/-LmResponseTimeoutMs/
-ConversationId/-TurnId/-DiscoverModels` (values are case-insensitive).
Channel directory defaults to `$TMPDIR/sessbridge` (override
`SESSBRIDGE_CHANNEL_DIR`); PID resolution order `--target-pid` →
`$VSCODE_PID` → `pgrep` → `ps -W` (Git Bash); falls back to the legacy shared
path when unresolved. Exit codes match the Python client (0/1/2/3).

### PowerShell compat layer (Windows)

```powershell
.\client\ps\sessbridge.ps1 -Message "hello"
.\client\ps\sessbridge.ps1 -Message "status" -Mode Silent -Model "DeepSeek V4 Flash"
.\client\ps\sessbridge.ps1 -Message "x" -Legacy -JsonOutput
```

Shares the same contract with the Python and sh implementations (golden
samples + contract tests); behavior drift is forbidden.

---

## 简体中文

### Python 3 客户端（主实现，仅 stdlib）

#### 安装（可选，pip）

```powershell
# 从仓库安装（生成 sessbridge 命令）
python -m pip install --no-deps .

# 之后可直接使用
sessbridge send --message "hello"
```

也支持不安装、直接从仓库调用：`python client\sessbridge.py send --message "hello"`。

#### 用法

```powershell
# 投递消息并等待回执（默认 visible，聊天面板可见）
python client\sessbridge.py send --message "hello"

# 静默直达 LM，捕获 AI 响应
python client\sessbridge.py send --message "status" --mode silent --model "DeepSeek V4 Flash"

# 优先 silent，失败回退 visible
python client\sessbridge.py send --message "status" --mode auto

# 列出可用 LM 模型
python client\sessbridge.py discover

# 继续会话（conversationId 上下文）
python client\sessbridge.py reply --message "继续" --conversation-id conv-x

# 等待既有回执（例如另一进程发出后，这里读取结果）
python client\sessbridge.py wait --request-id sess-xxxx

# 旧协议兼容（whois 文件名/载荷）
python client\sessbridge.py send --message "hello" --legacy

# JSON 输出 / 指定目标实例 / 自定义通道目录
python client\sessbridge.py send --message "x" --json-output --target-pid 12345
python client\sessbridge.py send --message "x" --channel-dir "D:\temp\sb"
```

退出码：`0` 成功；`1` 本地传输失败；`2` 扩展侧失败；`3` 参数校验失败。

### sh 客户端（Linux / macOS / POSIX，无需 Python）

`client/sh/sessbridge.sh` 是**纯 POSIX shell 实现**（仅 `sh` + 标准工具，
不依赖 Python / Node / jq），与 Python 主客户端和 PowerShell 兼容层共享同一契约：

```sh
# 投递消息（默认 visible）
sh client/sh/sessbridge.sh send --message "hello"

# 静默直达 LM，捕获 AI 响应
sh client/sh/sessbridge.sh send --message "status" --mode silent --model "DeepSeek V4 Flash Vision Exp"

# 列出可用 LM 模型
sh client/sh/sessbridge.sh discover

# 人类可读输出 / 多行可读回执（Format-List 风格） / JSON 输出
sh client/sh/sessbridge.sh send --message "hello"
sh client/sh/sessbridge.sh send --message "x" --pretty
sh client/sh/sessbridge.sh send --message "x" --json-output --keep

# 帮助
sh client/sh/sessbridge.sh --help
```

支持 `--mode/--model/--request-id/--target-pid/--channel-dir/--timeout/
--poll-interval/--keep/--json-output/--legacy/--priority/--auto-escalate/
--lm-response-timeout-ms/--conversation-id/--turn-id/--discover`。
**同时兼容 PowerShell 风格参数**：`-Message/-Mode/-Model/-RequestId/
-TargetPid/-ChannelDir/-TimeoutSec/-PollIntervalMs/-KeepTempFiles/
-JsonOutput/-Legacy/-Priority/-AutoEscalate/-LmResponseTimeoutMs/
-ConversationId/-TurnId/-DiscoverModels`（值大小写不敏感）。
通道目录默认 `$TMPDIR/sessbridge`（可用 `SESSBRIDGE_CHANNEL_DIR` 覆盖）；
PID 解析顺序 `--target-pid` → `$VSCODE_PID` → `pgrep` → `ps -W`（Git Bash），
无法解析时走 legacy 共享路径。退出码与 Python 客户端一致（0/1/2/3）。

### PowerShell 兼容层（Windows）

```powershell
.\client\ps\sessbridge.ps1 -Message "hello"
.\client\ps\sessbridge.ps1 -Message "status" -Mode Silent -Model "DeepSeek V4 Flash"
.\client\ps\sessbridge.ps1 -Message "x" -Legacy -JsonOutput
```

与 Python/sh 实现共享同一契约（黄金样例 + 契约测试），禁止行为漂移。
