# SessionBridge 开发计划（Dev Plan）

> 状态：进行中（2026-09-04）。权威协议：[RFC-sessbridge-channel-protocol-v1.md](RFC-sessbridge-channel-protocol-v1.md)。
> 本文件是工程侧实施映射：把 RFC 的阶段（S0/M1/M2/M3/M4）落到具体文件与验收标准。

## 1. 仓库布局（目标）

```
sessbridge/
  .github/workflows/   CI（三平台契约测试 + 静态门禁 + vsix 打包）
  extension/          VS Code 扩展（visible/silent/auto、多实例路由、旧协议兼容、S0 能力探针）
  client/
    sessbridge.py     Python 3 跨平台 CLI（send/wait/reply/discover）
    ps/
      Send-IpcChatMessage.ps1   PowerShell 兼容层（Windows；与 Python 契约一致）
  installer/
    install.ps1 / install.sh / uninstall*.ps1 / uninstall*.sh
    build-vsix.ps1 / build-vsix.sh      vsix 打包（vsce）
  tools/
    enforce_encoding.py                 编码/行尾门禁
    make_checksums.ps1 / make_checksums.sh  发布物 SHA256 清单
  tests/
    golden/           黄金样例（命令/回执/错误码/多实例/优先级/超时）
    test_contract.py  契约测试（mock 扩展 + 真实客户端）
  docs/
    RFC-sessbridge-channel-protocol-v1.md   协议（权威）
    DEV_PLAN.md                             本文件
    S0-CAPABILITY-SPIKE.md                  S0 能力验证清单
    capability-matrix.md                    能力矩阵（S0 后填写）
```

## 2. 里程碑映射

| 里程碑 | 本计划覆盖 | 验收 |
|---|---|---|
| **S0** | `extension/` 内置能力探针（`diag_<pid>.json`）；`docs/S0-CAPABILITY-SPIKE.md` 清单；`docs/capability-matrix.md` 模板 | 在目标 VS Code/Copilot 版本运行探针，填好能力矩阵，确认 visible 双向降级路线 |
| **M1** | extension + Python CLI + PS 兼容层 + installer + 旧协议兼容模式 + 契约测试（黄金样例） | `tests/test_contract.py` 全过；whois 旧客户端（`ipc_chat_sender.py` / `Send-IpcChatMessage.ps1`）在兼容模式回归全过 |
| **M2** | `conversationId/turnId/humanReply` 会话回合（在 S0 结论后冻结语义） | 人工审核/确认端到端 PASS |
| **M3** | 发布：vsix + 客户端包 + SHA256 + 兼容矩阵 + CI | 三平台客户端回归 PASS |
| **M4** | whois 侧调用脚本切换（旧实现保留过渡期） | whois 等价验证 PASS |

## 3. M1 实施要点（已定）

### 3.1 通道目录与文件

- 通道目录：`SESSBRIDGE_CHANNEL_DIR` 环境变量覆盖，默认 `%TEMP%\sessbridge`（Windows）/
  `$TMPDIR/sessbridge`（POSIX）；调用方与扩展必须一致。
- 新协议文件（通道目录内，PID 限定）：
  - `cmd_<pid>.json`（outbound，RFC §4.1 信封）
  - `res_<pid>.json`（inbound，RFC §4.2 回执）
  - `diag_<pid>.json`（诊断/能力探针）
- 旧协议文件（始终在系统临时目录，**不走** `SESSBRIDGE_CHANNEL_DIR`，保证 whois 兼容）：
  - `vscode_chat_send_cmd_<pid>.json` / `vscode_chat_send_res_<pid>.json`
  - 共享旧名：`vscode_chat_send_cmd.json` / `vscode_chat_send_result.json`

### 3.2 路由与身份

- 扩展只处理 `cmd_<pid>` 中 `pid == process.ppid`（主窗口 PID）的实例专用文件；
  共享旧名按旧行为由任一实例处理（与 whois 现状一致）。
- 客户端目标 PID 解析顺序：`--target-pid`（校验为 Code 进程）→ `$VSCODE_PID` →
  探测首个带窗口标题的 `Code.exe`；无法解析时回退旧共享路径（兼容）。

### 3.3 模式语义（M1 冻结，S0 只影响 M2 增强）

- `visible`：聊天面板投递（剪贴板 + 面板命令，沿用 whois 已验证机制）；回执即时返回，
  `humanReply` 留空（M2 采集）。
- `silent`：`vscode.lm` 直达，捕获 AI 响应写入 `response`；失败 `lm_api_unavailable`。
- `auto`：先 silent，失败回退 visible；回执以 `modeUsed` 标注实际路径。
- 响应必含：`status`、`requestId` 回显、`finishedAt`、`polledMs`、`extensionVersion`。

### 3.4 契约测试策略

- 黄金样例：`tests/golden/*.json` 固定信封/回执形状，测试锁定字段（防双实现漂移）。
- 契约测试（`tests/test_contract.py`，仅 stdlib）：
  - mock 扩展线程：检测 `cmd` 文件出现 → 写 `res`（快路径），验证退出码 0/1/2/3。
  - 新协议信封字段校验（`schemaVersion/requestId/mode/targetPid`）。
  - 旧协议兼容（文件名、`request_id`、`success/reason` 形状）与 whois 契约等价。
  - `discover`、超时（exit 1）、扩展失败（exit 2）、参数校验（exit 3）。

## 4. 当前进度

- [x] RFC 协议 v1（已提交 ee2f6c7）
- [x] 本项目仓库布局 + 开发计划
- [x] extension/（M1 + S0 探针）
- [x] client/（Python CLI + PS 兼容层）
- [x] installer/（install/uninstall PS1+SH、build-vsix PS1+SH、legacy 清理）
- [x] tests/（黄金样例 + 契约测试，21 项全过）
- [x] M3 发布准备：CI（`.github/workflows/ci.yml` 三平台矩阵）+ vsix 打包脚本 + SHA256 清单工具 + 编码门禁（含 golden）
- [ ] S0 能力探针运行 + 能力矩阵填写（需在真实 VS Code 中执行）
- [ ] whois 旧客户端兼容回归（需真实 VS Code 环境）
- [ ] M2 会话回合（待 S0 结论）
- [ ] M3 正式发布（vsix + 客户端包 + SHA256 + 兼容矩阵 + CI 徽章；需 S0/M2 后）
