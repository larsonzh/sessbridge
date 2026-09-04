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

## 3. 验证结果（真实 VS Code 实机）

| # | 验证项 | 方法 | 结论字段 |
|---|---|---|---|
| 1 | `vscode.chat` 命名空间存在 | `diag_28012.json` | ✅ `hasChatNamespace=true`，35 个 chat keys |
| 2 | `requestHandler` / `createChatParticipant` 可用 | `diag_28012.json` | ✅ participant=true；❌ requestHandler=false |
| 3 | `vscode.lm.selectChatModels` 可用 | `diag_28012-lm.json` | ✅ 34 个模型，无 probe error |
| 4 | Copilot silent 端到端 | `Auto` 探针 | ✅ exit 0，`status=ok`，`modeUsed=silent`，response 非空 |
| 5 | DeepSeek silent 端到端 | requestId `s0-deepseek-4`，PID `28012` | ✅ exit 0，`status=ok`，响应 `S0-OK` |
| 6 | 人工回复捕获可行性 | API 探针 | ⚠️ 全量捕获不可行；M2 使用受控 participant |
| 7 | 多实例路由 | PID-scoped 通道与扩展 `process.ppid` 校验 | ✅ 协议/代码路径已验证；双窗口实测留作后续回归 |
| 8 | 旧协议兼容回归 | 21 项契约测试含 legacy parity | ✅ 测试通过，whois 协议未改 |

## 4. 结论记录

以上 #1–#8 结果已同步到 `docs/capability-matrix.md`。按结果决定 M2 会话回合落地方式：
- requestHandler/participant 可用 → 扩展内捕获 `humanReply`，`wait`/`reply` 走会话回合。
- 不可用 → 继续保持 M1 语义；`humanReply` 由受控回执文件由人工/外部补充（文档化降级）。
