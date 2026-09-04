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

## 2.1 真实 VS Code runtime smoke（CI）

该 smoke 使用 `@vscode/test-electron@3.1.0` 启动隔离的 VS Code Extension Host，
不依赖 Copilot 登录或具体 LM 提供方。测试会激活 `larsonzh.sessbridge`，读取真实
`diag_<pid>.json`，再通过真实 PID-scoped 文件通道发送空消息并校验
`status: "no_message"` 回执。

本地 Windows（需要 Node.js 22、桌面 VS Code 下载网络）运行：

```powershell
npm install --no-save --no-package-lock @vscode/test-electron@3.1.0
node tests\run-runtime-smoke.js
```

本地 Linux（需要 Node.js 22、xvfb、网络）运行：

```sh
npm install --no-save --no-package-lock @vscode/test-electron@3.1.0
xvfb-run -a node tests/run-runtime-smoke.js
```

CI 对应 job 使用 VS Code `1.136.1`；下载缓存目录 `.vscode-test/` 已加入忽略清单。
2026-09-04 本机 Windows 实测 PASS：Extension Host 退出码 `0`，扩展版本 `0.1.0`，
真实回执 `status: "no_message"`，PID 路由校验通过。

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
