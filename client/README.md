# SessionBridge client

## Python 3 客户端（主实现，仅 stdlib）

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
$env:SESSBRIDGE_CHANNEL_DIR = "D:\temp\sb"; python client\sessbridge.py send --message "x"
```

退出码：`0` 成功；`1` 本地传输失败；`2` 扩展侧失败；`3` 参数校验失败。

## PowerShell 兼容层（Windows）

```powershell
.\client\ps\Send-IpcChatMessage.ps1 -Message "hello"
.\client\ps\Send-IpcChatMessage.ps1 -Message "status" -Mode Silent -Model "DeepSeek V4 Flash"
.\client\ps\Send-IpcChatMessage.ps1 -Message "x" -Legacy -JsonOutput
```

与 Python 实现共享同一契约（黄金样例 + 契约测试），禁止行为漂移。
