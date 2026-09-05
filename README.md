# SessionBridge / 会话桥

> *A two-way session bridge between VS Code Copilot Chat and external automation.*
> 外部自动化与 VS Code Copilot Chat 之间的双向会话桥。

[English](#english) · [简体中文](#简体中文)

## English

SessionBridge is an independent open-source product that provides a **two-way
session bridge** between external scripts / unattended tasks (e.g. ProofRail,
whois A/B flows) and VS Code Copilot Chat — it delivers messages and can also
capture responses, supporting human review and confirmation at critical
checkpoints.

It originates from the `IPC Chat Sender` practice in the whois project, but is
positioned as a standalone product:

- **Session-level bidirectional (Session, not Send)**: `conversationId`/`turnId`
  identify conversation turns and reuse VS Code's chat panel, history, and
  human–AI interaction mechanism.
- **Modes**:
  - `visible`: message visible in the chat panel, supports human–AI exchange
    (primary mode; ProofRail development relies on it for review/approval).
  - `silent`: LM API direct, zero UI, captures AI response (status tickets /
    unattended automation).
  - `auto`: try `silent` first, fall back to `visible`.
- **Cross-platform**: `extension/` (VS Code extension) + `client/` (Python 3
  client as the primary implementation, PowerShell compat layer, and a POSIX
  `sh` client for Linux/macOS — same channel contract) + `installer/`
  (install/update/uninstall).

### Naming (RFC convention, brief)

- Adopted **SessionBridge / `sessbridge` / 会话桥**: GitHub user/org 404,
  repo search 0, npm 404; semantically matches "session-level bidirectional".
- **Abbreviation rule**: never use `sb` (unpleasant association in Chinese
  internet context); prefer `sess` or `sbr` internally.

### Repository layout

```
extension/   VS Code extension (visible/silent/auto, multi-instance routing,
             S0 capability probe, legacy protocol compat)
client/      Python / PowerShell / sh cross-platform clients
             (send/wait/reply/discover; same channel contract)
installer/   install/update/uninstall scripts, vsix packaging
tests/       contract tests + golden samples (cmd/receipt/exit codes/
             multi-instance/priority/timeout)
docs/        channel protocol v1 spec, dev plan, S0 spike checklist,
             capability matrix
```

### Quick start (M1)

```powershell
# 1. Install the extension (then reload the window)
powershell -File installer\install.ps1 -Force

# 2. Deliver a message (default visible: appears in the chat panel)
python client\sessbridge.py send --message "hello"

# 3. Silent mode: LM API direct, captures the AI response
python client\sessbridge.py send --message "status" --mode silent --model "DeepSeek V4 Flash"

# 4. PowerShell compat layer
.\client\ps\sessbridge.ps1 -Message "hello"

# 5. POSIX sh client (Linux/macOS)
sh client/sh/sessbridge.sh send --message "hello"

# 6. Contract tests
python tests\test_contract.py
```

### Protocol

Authoritative spec: [docs/RFC-sessbridge-channel-protocol-v1_EN.md](docs/RFC-sessbridge-channel-protocol-v1_EN.md)

Boundary note: ProofRail (证轨) relies on the `visible` mode for human review
and confirmation at critical development checkpoints (see Modes above); its
unattended automation consumes the `silent` channel and file queue. `visible`
human interaction is a SessionBridge product capability.

### Documentation

- Full guide: [docs/SESSBRIDGE_README_EN.md](docs/SESSBRIDGE_README_EN.md)
- Troubleshooting: [docs/SESSBRIDGE_TROUBLESHOOTING_EN.md](docs/SESSBRIDGE_TROUBLESHOOTING_EN.md)
- Coding conventions: [docs/CODING_CONVENTIONS_EN.md](docs/CODING_CONVENTIONS_EN.md)
- Dev plan / S0 spike / capability matrix: `docs/DEV_PLAN_EN.md`,
  `docs/S0-CAPABILITY-SPIKE_EN.md`, `docs/capability-matrix_EN.md`

### Encoding rules (hard rule)

Per [docs/CODING_CONVENTIONS_EN.md](docs/CODING_CONVENTIONS_EN.md):

- `.md` / `.ps1` / `.json`: UTF-8 **with BOM** + **LF** (`extension/package.json`
  is the exception: UTF-8 **without BOM** + LF).
- Other files: UTF-8 **without BOM** + **LF**.
- Gate: `python tools\enforce_encoding.py` (`--fix` only converts
  encoding/EOL, never changes semantics).

### License / Release plan

MIT (Copyright (c) 2026 larsonzh)

- GitHub public repository + **Gitee mirror backup**.
- Releases: vsix + cross-platform client package + SHA256 + compatibility
  matrix + standalone CI.

---

## 简体中文

SessionBridge 是一个独立开源产品：让外部脚本、无人值守任务（如 ProofRail / whois A/B 流程）
与 VS Code Copilot Chat **双向交互**——既能投递消息，也能接收并捕获人工回复，支撑任务关键节点的
人工审核与确认。

它源自 whois 项目的 `IPC Chat Sender` 实践，但定位为独立产品：

- **会话级双向（Session 而非 Send）**：以 `conversationId`/`turnId` 标识对话回合，利用 VS Code
  现有聊天面板、聊天记录与人机交互机制，支持人与 AI 交流。
- **模式**：
  - `visible`：消息在聊天面板可见，支持人与 AI 交流（**主要工作方式**；ProofRail 开发期关键
    节点的人工审核/确认依赖此模式）。
  - `silent`：LM API 直达、零 UI 干扰、捕获 AI 响应（无人值守状态票等自动化场景）。
  - `auto`：先 silent，失败回退 visible。
- **跨平台**：`extension/`（VS Code 扩展）+ `client/`（Python 3 跨平台客户端为主，PowerShell
  兼容层与 POSIX `sh` 客户端（Linux/macOS）共享同一通道契约）+ `installer/`（安装/更新/卸载）。

## 命名记录（RFC 惯例）

- 采用 **SessionBridge / `sessbridge` / 会话桥**：GitHub 用户/组织 404、仓库检索 0、
  npm 404，全部未占用；语义贴合“会话级双向交互”。
- **简称纪律**：不用 `sb`（中文互联网语境存在不雅联想）；内部建议 `sess` 或 `sbr`。

## 仓库结构

```
extension/   VS Code 扩展（visible/silent/auto、多实例路由、S0 能力探针、旧协议兼容模式）
client/      Python / PowerShell / sh 跨平台客户端（send/wait/reply/discover；同一通道契约）
installer/   安装/更新/卸载脚本与 vsix 打包
tests/       契约测试 + 黄金样例（命令/回执/错误码/多实例/优先级/超时）
docs/        通道协议 v1 规范、开发计划、S0 能力验证清单、能力矩阵
```

## 快速开始（M1）

```powershell
# 1. 安装扩展（需要重载窗口）
powershell -File installer\install.ps1 -Force

# 2. 投递消息（默认 visible：聊天面板可见）
python client\sessbridge.py send --message "hello"

# 3. 静默直达 LM，捕获 AI 响应
python client\sessbridge.py send --message "status" --mode silent --model "DeepSeek V4 Flash"

# 4. PowerShell 兼容层
.\client\ps\sessbridge.ps1 -Message "hello"

# 5. POSIX sh 客户端（Linux/macOS）
sh client/sh/sessbridge.sh send --message "hello"

# 6. 契约测试
python tests\test_contract.py
```

## 协议

权威规范：[docs/RFC-sessbridge-channel-protocol-v1.md](docs/RFC-sessbridge-channel-protocol-v1.md)

边界说明：ProofRail（证轨）开发期关键节点的人工审核/确认依赖 `visible` 模式（见上「模式」）；
其无人值守自动化通过 `silent` 通道与文件队列获取生成结果。`visible` 人工交互是 SessionBridge
产品能力。

## 文档导航

- 完整指南：[docs/SESSBRIDGE_README.md](docs/SESSBRIDGE_README.md)
- 快速排障：[docs/SESSBRIDGE_TROUBLESHOOTING_CN.md](docs/SESSBRIDGE_TROUBLESHOOTING_CN.md)
- 编码与工程规范：[docs/CODING_CONVENTIONS.md](docs/CODING_CONVENTIONS.md)
- 开发计划 / S0 能力验证 / 能力矩阵：`docs/DEV_PLAN.md`、`docs/S0-CAPABILITY-SPIKE.md`、`docs/capability-matrix.md`

## 编码规范（硬规则）

按 [docs/CODING_CONVENTIONS.md](docs/CODING_CONVENTIONS.md)：

- `.md` / `.ps1` / `.json`：UTF-8 **with BOM** + **LF**（`extension/package.json` 例外：无 BOM + LF）。
- 其它文件：UTF-8 **without BOM** + **LF**。
- 门禁：`python tools\enforce_encoding.py`（`--fix` 仅做编码/EOL 转换）。

## 许可证

MIT（Copyright (c) 2026 larsonzh）

## 发布计划

- GitHub 公开仓库 + **Gitee 镜像备份**。
- 发布物：vsix + 跨平台客户端包 + SHA256 + 兼容矩阵 + 独立 CI。
