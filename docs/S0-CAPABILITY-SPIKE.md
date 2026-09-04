# S0：VS Code Chat API 双向能力验证（Capability Spike）

> 目标：验证 `visible` 双向能力（人工回复捕获）在当前 VS Code / Copilot 版本可用性，
> 冻结模式语义，产出能力矩阵。**不可省略**（RFC §5）。
> 降级路线：若宿主 API 受限，保留“投递 + 轮询回执”单向语义（M1 已实现），
> `humanReply` 受控回执文件补充；**不得**退化为 GUI 自动化。

## 1. 前置

- 已安装 sessbridge 扩展：`powershell -File installer\install.ps1 -Force`
- 已安装并登录 GitHub Copilot / 对应 LM 通道（DeepSeek 等）
- 重启 VS Code 窗口使扩展激活

## 2. 运行探针

1. 正常打开 VS Code 窗口（扩展在 `onStartupFinished` 激活）。
2. 打开集成终端（`Ctrl+``），确认 `$env:VSCODE_PID` 存在。
3. 扩展启动时会自动写两份探针（通道目录默认 `%TEMP%\sessbridge`）：
   - `diag_<pid>.json`：`extension_activated` 探针（chat/lm 命名空间、版本、API 键）
   - `diag_<pid>-lm.json`：`lm_probe` 探针（模型数量、copilot 模型）
4. 检查探针：
   ```powershell
   $d = "$env:TEMP\sessbridge"
   Get-Content "$d\diag_$(Get-Process Code | Where-Object MainWindowTitle | Select-Object -First 1 -ExpandProperty Id).json"
   ```

## 3. 待验证项（人工在真实 VS Code 中执行）

| # | 验证项 | 方法 | 结论字段 |
|---|---|---|---|
| 1 | `vscode.chat` 命名空间存在 | 探针 `diag_*.json` | `hasChatNamespace` / `chatKeys` |
| 2 | `vscode.chat.requestHandler` / `createChatParticipant` 可用 | 探针 | `hasRequestHandler` / `hasCreateChatParticipant` |
| 3 | `vscode.lm.selectChatModels` 可用（silent 依赖） | 探针 `*-lm.json` | `modelCount`、`!error` |
| 4 | silent 端到端 | `python client/sessbridge.py send --message "ping" --mode silent` | exit 0 + `response` 非空 |
| 5 | visible 端到端 | `python client/sessbridge.py send --message "请回复收到"` | 聊天面板出现消息 |
| 6 | 人工回复捕获可行性 | 对 `vscode.chat` 事件/参与者 API 做最小 spike（与 Copilot 现有 participant 共存） | 可行/不可行 + 依据 |
| 7 | 多实例路由 | 开两个 VS Code 窗口，`--target-pid <pid>` 分别投递 | 各实例独立响应 |
| 8 | 旧协议兼容回归 | whois `ipc_chat_sender.py --message x`（同一 VS Code 实例） | exit 0，whois 脚本不变 |

## 4. 结论记录

把 #1–#8 结果填入 `docs/capability-matrix.md`，并按结果决定 M2 会话回合落地方式：
- requestHandler/participant 可用 → 扩展内捕获 `humanReply`，`wait`/`reply` 走会话回合。
- 不可用 → 继续保持 M1 语义；`humanReply` 由受控回执文件由人工/外部补充（文档化降级）。
