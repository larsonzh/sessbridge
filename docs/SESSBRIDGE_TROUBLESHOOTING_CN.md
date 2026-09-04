# SessionBridge 快速排障清单（CN）

适用范围：`client/sessbridge.py`、`client/ps/Send-IpcChatMessage.ps1`、
`extension/extension.js`、ProofRail 等通过 `silent` 消息层接入的调用方。

## 1. 30 秒快速判定

1. 先看退出码：`0`=收到回执且 status=ok；`1`=本地传输失败；`2`=扩展侧失败；`3`=参数校验失败。
2. 无退出码或进程卡住：**先确认扩展是否安装并重载**（最常见原因）。
3. `poll_timeout` 优先怀疑：通道目录不一致 / 目标 PID 不匹配 / 扩展未激活。
4. `lm_api_unavailable` 优先怀疑：LM 通道未就绪（模型列表为空/未登录/网络代理）。
5. 消息未出现但退出码 0：看聊天面板/聊天 worker；visible 已提交但不代表 AI 在响应。

## 2. 常见故障 -> 处理动作

### A. `poll_timeout`（扩展未响应）

现象：客户端轮询超时，退出码 1。

处理（按序）：
1. `code --list-extensions | Select-String larsonzh` 确认存在 `larsonzh.sessbridge`。
2. `Ctrl+Shift+P → Developer: Reload Window` 重载窗口。
3. 检查通道目录一致性：调用方与扩展必须使用同一个 `SESSBRIDGE_CHANNEL_DIR`；
   默认都是 `%TEMP%\sessbridge`，**绝不允许**一边默认一边自定义。
4. 检查目标 PID：集成终端用 `$env:VSCODE_PID`；外部终端需 `--target-pid` 或自动探测；
   无法探测时回退旧共享文件（legacy）。
5. 仍失败：重装扩展 `installer\install.ps1 -Force` 并重载。
6. 查看 `%TEMP%\sessbridge\diag_<pid>.json` 是否 `extension_activated`。

### B. 通道目录不一致（新旧混用）

现象：客户端写 `cmd_<pid>.json` 到 A 目录，扩展轮询 B 目录。

处理：
- 统一 `SESSBRIDGE_CHANNEL_DIR`；检查是否残留旧会话设置过环境变量。
- 共享旧文件永远在 `%TEMP%`，与 `SESSBRIDGE_CHANNEL_DIR` 无关（设计如此，勿改）。

### C. 多实例路由串扰 / 找不到实例

现象：消息进了错误的 VS Code 窗口。

处理：
- `Get-Process -Name Code | Where-Object MainWindowTitle | Format-Table Id,StartTime`
  只看主窗口；用 `--target-pid` 显式指定。
- 同一进程内多窗口（同 PID）无法区分——那是固有局限（见指南 Q1）。

### D. Silent 模式 `lm_api_unavailable`

现象：退出码 2，status=`lm_api_unavailable`。

处理：
1. `python client\sessbridge.py discover` 看模型列表是否为空。
2. 模型为空：确认 Copilot/对应 LM 通道已登录、代理已配置。
3. `model_options` 键值取决于具体模型（未公开文档化），
   错误键值可能导致模型拒绝请求。

### E. 编码坑（JSON BOM / PS 5.1 乱码）

现象：
- 扩展报 `Unexpected token` / 命令文件解析失败。
- PowerShell 中文乱码。

处理：
- 写 JSON 给 Node 解析**必须无 BOM**：PS 用
  `[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))`；
  Python 用 `json.dump(..., ensure_ascii=False)`（默认无 BOM）。
- 仓库内 Markdown/PS/JSON 按规范 BOM+LF（`tools\enforce_encoding.py` 门禁），
  但**运行时 IPC 文件不算仓库文件**，一律无 BOM + 无 CRLF 转换。

### F. PowerShell 5.1 内联 `if` 子表达式（重点坑位）

现象：脚本运行到一半报 `The term 'if' is not recognized...`。

根因：PS 5.1 下 `$(if (...) { } else { })` 字符串插值会触发语法异常。

处理：禁止在无人值守关键脚本使用内联 `$(if...)`；先计算变量再传参。
排查：`rg --line-number --glob "**/*.ps1" "\$\(if\s*\("`

### G. 陈旧结果导致假 `poll_timeout`

现象：偶尔一次发送报 `poll_timeout`，重发立即成功。

根因：写完新命令后再删旧结果，把扩展刚写的新回执误删（历史坑）。

处理：契约已固定“**先删同 requestId 的陈旧结果，再写新命令**”（RFC §4.1）；
客户端版本过旧时升级。保留现场用 `--keep` / `-KeepTempFiles`。

### H. 新旧扩展双装冲突

现象：legacy 场景消息被发两次 / 回执被竞争删除。

处理：SessionBridge 与旧 `vscode-chat-sender` 都会轮询旧文件名——
**只保留一个**。whois 迁入期执行 `installer\uninstall-legacy.ps1`。

## 3. 检查点（无人值守接入）

- 扩展已安装并重载（`code --list-extensions | Select-String sessbridge`）。
- 通道目录环境变量若设置，调用方与扩展一致。
- ProofRail 只消费 `silent` 消息层 + 文件队列：消息带 `requestId`、
  按需 `--auto-escalate`、超时后按退出码分类（1=本地，2=扩展侧）。
- 消息安全：消息不含机密凭据是**调用方约定**，扩展/客户端当前**不做**任何脱敏处理
  （诊断文件与回执原样透传消息/响应内容），需要脱敏保证请自行在写入前处理。

## 4. 最小验证命令

```powershell
# 通道冒烟（visible）
python client\sessbridge.py send --message "sessbridge-selftest" --json-output

# Silent 直达 + 捕获响应
python client\sessbridge.py send --message "ping" --mode silent --timeout 60 --json-output

# 模型发现
python client\sessbridge.py discover

# 契约测试自检（纯本地，无需 VS Code）
python tests\test_contract.py

# 编码门禁
python tools\enforce_encoding.py
```

## 5. 证据与日志位置

- 通道目录：`%TEMP%\sessbridge`（`cmd_*` / `res_*` / `diag_*`）。
- 扩展诊断：`diag_<pid>.json`（激活/API 探针）、`diag_<pid>-lm.json`（模型探针）。
- 旧协议文件：`%TEMP%\vscode_chat_send_*`。
- 扩展清理动作：`diag_<pid>.json` 的 `reason=stale_cleanup`（>24h 陈旧文件）。

结论判定优先级：客户端退出码/回执 JSON → `diag_*` 探针 → 聊天 worker 状态。
不要把“聊天 worker 响应中断”误判为“发送失败”。
