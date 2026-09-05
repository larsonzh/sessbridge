# RFC：SessionBridge 通道协议 v1 / SessionBridge Channel Protocol v1

> English：[RFC-sessbridge-channel-protocol-v1_EN.md](RFC-sessbridge-channel-protocol-v1_EN.md)

> 状态：Draft（草案，v1.0.0，2026-09-04）。本文定义 SessionBridge 的通道协议 I 版：VS Code
> Copilot Chat 与外部自动化之间**会话级双向**交互的本地文件/IPC 契约。
>
> 修订（2026-09-05）：增补 §5.1 静默会话历史（silent 多轮上下文）契约；
> 增补 §5.2 人工回复受控通道（M2 `humanReply`）契约。
>
> 来源与继承：脱胎于 whois 项目 `tools/test/` 的 IPC Chat Sender（`vscode-chat-sender` 扩展、
> `Send-IpcChatMessage.ps1`、`ipc_chat_sender.py`、`install_ipc_chat_extension.ps1` 与
> `docs/IPC_CHAT_SENDER_README.md`）。whois 侧旧实现保持不动，保证其 A/B 无人值守流程
> 不间断使用；本协议提供“旧协议兼容模式”实现无缝承接。

## 1. 目的与非目标

### 1.1 目的

- 定义一个**会话级双向**、可回执、幂等、可审计的本地通道：外部脚本（PowerShell / Python /
  ProofRail 等）向 VS Code Copilot Chat 投递消息，并能**捕获人工/AI 回复**。
- 支持三种模式：`visible`（聊天面板可见，双向、完整上下文）、`silent`（LM API 直达，
  零 UI、捕获 AI 响应）、`auto`（先 silent 后 visible）。
- 支持多 VS Code 实例路由（按目标实例 PID）。
- 提供旧协议兼容模式，使 whois 现有流程无需修改即可接入本产品。
- 跨平台客户端：Python 3（主实现）、PowerShell（Windows 兼容层）。

### 1.2 非目标

- 不实现聊天 UI/独立聊天系统（由 VS Code Copilot Chat 宿主提供）。
- 不采用 GUI 自动化兜底（AHK、键盘模拟、剪贴板注入、窗口焦点控制）。
- 不定义 ProofRail 任务/票据/门禁语义；ProofRail 仅通过本协议的 `silent` 消息层与文件队列
  接入（见第 7 节边界）。
- 不承诺跨主机/远程通道（首版为本地单用户；远程与签名后续另行 RFC）。

## 2. 名称与命名记录（RFC 惯例）

| 层级 | 采用 | 说明 |
|---|---|---|
| 正式名称 | **SessionBridge** | 会话级双向，避开 ChatBridge 商标/重名 |
| 工程名/仓库 | `sessbridge` | 全小写无连字符 |
| 中文名 | **会话桥** | — |
| 内部简称（推荐） | `sess` 或 `sbr` | **不用 `sb`**（中文互联网语境存在不雅联想） |

名称可用性检查（2026-09-04，GitHub API / npm / 公开检索）：

- **ChatBridge / `chatbridge` 不可用**：USPTO 注册商标 CHATBRIDGE（ARI Network Services,
  Inc.，注册号 88962890，覆盖即时通讯/客服 SaaS 类别）；商业产品 ChatBridge AI
  （chatbridgeapp.com）；GitHub 同类项目 `ylexLiao/chatbridge`（跨 Copilot/Codex/Claude
  聊天历史桥接）与 `HARIOM8859/ChatBridge-Extension`；Chrome Web Store 同名扩展。
- **DialogBridge / `dialogbridge` 可用**（GitHub 用户/组织 404，仓库检索仅 2019 年停更的
  `EricDahlvang/DialogBridgePlayground` 无冲突，npm 404），但名称较长；
  **DlgBridge / `dlgbridge`** 亦可用（GitHub 用户/组织 404、仓库检索 0、npm 404），
  但辨识度一般，均未采用。
- **SessionBridge / `sessbridge` 采用**：GitHub 用户/组织 404、仓库检索 total_count=0、
  npm 404；语义精准贴合“会话级双向交互”；中文“会话桥”简短自然。

## 3. 总体模型

### 3.1 通道拓扑

```
外部客户端 (PowerShell / Python / ProofRail agent)
    │  写入 <通道目录>/cmd_<targetPid>.json   （outbound 消息）
    │  读取 <通道目录>/res_<targetPid>.json   （回执 / 回复）
    ▼
SessionBridge 扩展（VS Code，轮询 <channel_dir>）
    │  仅处理匹配自身 process.ppid 的命令文件
    │  分发 mode：
    │    visible → 聊天面板投递 + 会话事件捕获（人工/AI 回复）
    │    silent  → LM API 直达 → 捕获 AI 响应（零 UI）
    │    auto    → 先 silent，失败回退 visible
    ▼
VS Code Copilot Chat（会话、上下文、人工审核/确认）
```

- **会话级双向的定义**：`outbound`（外部 → Chat 投递消息）与 `inbound`（Chat/人工 → 外部回传
  回复）构成一次对话回合；`conversationId + turnId` 标识回合，支持续接既有会话上下文。
- 通道目录默认：`%TEMP%\sessbridge`（Windows）/ `$TMPDIR/sessbridge`（POSIX）；
  可用环境变量 `SESSBRIDGE_CHANNEL_DIR` 覆盖（一致性要求：调用方与扩展必须一致）。

### 3.2 多实例路由

- 每个 VS Code 实例的扩展只处理**以自己主窗口 PID 命名**的通道文件（校验 `process.ppid`）。
- 调用方通过 `targetPid` 指定目标实例；集成终端调用自动使用 `$env:VSCODE_PID`；
  外部终端自动探测或显式指定。
- 无法运行时探测且未指定目标：兼容旧共享路径（`vscode_chat_send_cmd.json` /
  `vscode_chat_send_res.json`），扩展以兼容模式处理（见第 6 节）。

## 4. 消息信封与回执（v1）

### 4.1 消息信封（outbound，`cmd_<pid>.json`）

```json
{
  "requestId": "sess-<auto-uuid>",
  "mode": "visible | silent | auto",
  "priority": "high | normal",
  "message": "string",
  "targetPid": 12345,
  "timeoutMs": 90000,
  "lmResponseTimeoutMs": 180000,
  "conversationId": "optional-existing-session-context",
  "turnId": 0,
  "createdAt": "2026-09-04T00:00:00Z",
  "legacy": false
}
```

字段契约：

- `requestId` 未提供时由客户端生成（`sess-` 前缀 + uuid）；**回执必须绑定同一 requestId**。
- `priority=high`：打断当前 AI 工作立即发送（事件驱动票）；`normal`：排队等待（状态票）。
- `timeoutMs`：调用方等待回执上限；`lmResponseTimeoutMs`：silent 模式下覆盖扩展侧 LLM
  响应等待（仅本次生效），未提供时用扩展侧默认。
- `resetHistory`（可选，默认 `false`）：silent/auto 模式下显式清空该 `conversationId` 的
  会话历史并重新开始（新会话直接用新的 `conversationId` 即可，无需该字段）。
- `noCompress`（可选，默认 `false`）：silent 模式下跳过当前轮次对 assistant 回复的截断压缩
  （用于交付 diff patch、结构化配置、代码生成等严禁任何断裂的关卡轮次）。
- 写命令文件前，客户端**必须先清理该 requestId 的陈旧结果文件**（先删旧结果再写新命令，
  防止误删此轮新鲜回复导致假 `poll_timeout`——继承 whois 已验证的坑）。
- 客户端写命令文件必须**原子写**（同目录临时文件 + rename/replace 落位），禁止直接写出
  目标文件：扩展按轮询发现文件，绝不应当读到半写状态；命令文件方向与回执方向同等要求。

### 4.2 回执（inbound，`res_<pid>.json`）

```json
{
  "schemaVersion": "1",
  "requestId": "sess-<same-as-outbound>",
  "status": "ok | lm_api_unavailable | extension_error | busy | timeout | ...",
  "mode": "visible | silent | auto",
  "response": "AI 或人工回复文本（可能为空）",
  "humanReply": "人工回复（visible 双向回合时捕获，可能为空）",
  "conversationId": "session context",
  "turnId": 1,
  "history": {
    "totalTurns": 1,
    "inputTokensEst": 1200,
    "isTruncated": false,
    "evictedTurns": 0
  },
  "error": "extension-side error detail",
  "polledMs": 1234,
  "extensionVersion": "x.y.z",
  "finishedAt": "2026-09-04T00:00:05Z"
}
```

- 扩展进程必须**独占写**结果文件（临时文件 + 原子重命名），调用方轮询读取。
- `humanReply` 仅在 `visible` 双向回合内非空；silent 无人工参与。
- `history` 对象（可选）：当且仅当 silent/auto 模式下显式提供了非空 `conversationId`
  时回显，提供上下文健康度指标（`totalTurns` 总轮数、`inputTokensEst` 估算输入 Token、
  `isTruncated` 是否已发生剔除、`evictedTurns` 剔除轮数），供自动化流程（如 ProofRail）
  判定是否需要上下文重置或阶段切换。
- 回执 `status` 值集合在实现时冻结并进入黄金样例。

### 4.3 错误码契约（客户端退出码，继承 whois 契约）

| 退出码 | 含义 |
|---|---|
| `0` | 成功（收到回执且 status=ok） |
| `1` | 本地传输失败（poll_timeout / write_cmd_failed / 通道目录不可用） |
| `2` | 扩展侧失败（status=extension_error / lm_api_unavailable） |
| `3` | 参数校验失败 |

### 4.4 幂等与并发

- `requestId` 去重：扩展对重复 requestId 幂等处理；客户端重试必须复用 requestId（同 attempt）。
- 结果文件单实例、原子写；优先级 `high` 打断语义仅对本实例生效。
- 消息与回执的寿命：超过保留期（默认 24h）或已被消费的陈旧文件由扩展/调用方清理，
  清理动作留痕到诊断日志。
- **同一响应文件的串行化（不同 `requestId` 的重叠请求）**：响应文件（`res_<pid>.json` 及各
  legacy 等价文件）是单一槽位，一次只能承载一份回执。扩展按**响应文件路径**维护 in-flight
  标记：若上一条命令（任意 `requestId`）仍在处理中，同路径的新命令**立即**返回
  `status: "busy"`（legacy：`reason: "busy"`），而不是让两次写入互相覆盖、造成先到请求的
  回执被静默吞掉、调用方误判为 `poll_timeout`。调用方收到 `busy` 应自行退避重试；
  客户端退出码归类为 `2`（扩展侧失败，非本地传输失败）。
  新协议通道与 legacy 通道使用不同的物理文件，因此二者互不受此限制影响。
- **损坏命令文件隔离**：命令文件无法解析为 JSON 时，扩展必须将其重命名隔离
  （`<file>.bad-<pid>-<timestamp>`）并写诊断记录（`diag_<pid>.json`，
  `reason: "invalid_command_payload"`），不得原地保留后在下一轮询继续读取——
  否则会造成静默无限重试，调用方只看到 `poll_timeout` 且无法定位根因。
- **成功回执的幂等重放**（回应单槽位回执的残余竞态）：回执文件是单槽位，客户端
  “先删陈旧回执再写命令”与扩展 `busy` 写入之间仍存在极小窗口——并发请求 B 的
  `busy` 可能覆盖刚完成的请求 A 的回执，令 A 的调用方看到一次假 `poll_timeout`。
  处理：客户端按 RFC §4.4 复用同一 `requestId` 重试；扩展对**成功类**回执
  （`status=ok/discovery` 或 legacy `success=true`）做内存缓存（默认 5 分钟、
  ≤50 条，按 `requestId`），收到同 `requestId`、同通道文件、同消息的新命令时
  **直接重放缓存回执**，不重复执行副作用（粘贴/LM 调用）。错误类回执不缓存，
  重试必须真实再执行。该机制不改变线上协议形态（回执仍为 `res_<pid>.json`）。

## 5. 模式语义（S0 能力验证后冻结）

| 模式 | 方向 | 依赖 | 定位 |
|---|---|---|---|
| `visible` | 双向 | VS Code Chat API（会话事件、面板投递、人工回复捕获） | **主要工作方式**：完整聊天记录、人机交流、关键节点审核/确认；ProofRail 开发期依赖 |
| `silent` | 单向（AI 回复） | LM API（不公开接口，需兼容矩阵） | 无人值守状态票/低打扰自动化 |
| `auto` | 视能力 | 先 silent、失败回退 visible | 兼容/便利 |

- **S0 capability spike**（不可省略）：验证 visible 双向能力在目标 VS Code/Copilot 版本中可用；
  若受限于宿主 API，保留“投递 + 轮询回执”单向语义，人工回复以受控回执文件补充，
  并如实记录能力矩阵，**不得**退化为 GUI 自动化。
- 兼容矩阵必须记录：VS Code 版本、Copilot 扩展版本、LM API 可用性、聊天事件可用性。

### 5.1 静默会话历史（silent 多轮上下文）

- **目标**：让 `silent`（含 `auto` 的 silent 路径）多轮调用保持上下文——AI 能引用先前轮次的
  事实继续工作；`visible` 面板会话**默认隔离**，不受影响、不互相污染。
- **空 `conversationId` 退化语义（纯无状态防串台）**：
  - 当且仅当 `conversationId` 显式非空且非空白时，才激活会话历史引擎。
  - 若调用方不传或传入空字符串 `conversationId`，保持**纯无状态单次调用**（旧行为兼容），
    既不读取也不写入任何历史文件，彻底杜绝所有无会话标记命令共享同一历史的串台风险。
- **模型与历史记录**：
  - 扩展按 `conversationId` 维护消息历史 `messages[]`（每项含 `role`: `user`/`assistant`、
    `content`: 文本、`requestId`: 对应命令标识、`turnId`: 轮次号、`createdAt`: 时间戳）。
  - 每次激活会话历史的 silent 请求，扩展组装
    `requests = 历史 messages + 当前用户 message` 后经适配器传给 `vscode.lm`。
- **原子提交与失败隔离原则**：
  - **原子提交**：只有当 LM API 完整生成成功且 `status == "ok"` 时，才将该轮的 `User` 消息
    与 `Assistant` 响应持久化追加进 `history_<conversationId>.json`。
  - **失败不污染**：任何非成功请求（`timeout` / `lm_api_unavailable` / `extension_error` /
    校验失败等），该轮未完成的 `User` 消息立即丢弃、回滚，严禁写入历史，确保后续轮次上下文干净。
- **重试幂等性保证**：
  - 历史中的每轮消息绑定 `requestId`。若客户端发生网络重试，且传入的 `requestId` 已经存在于
    当前历史中，扩展按 §4.4 直接重放已有成功回执，**严禁向历史重复追加**相同内容。
- **历史持久化与并发控制**：
  - 存储路径：通道目录内 `history_<conversationId>.json`（运行时文件：UTF-8 无 BOM + LF；
    与 `cmd_<pid>.json` / `res_<pid>.json` / `diag_<pid>.json` 一致，**不适用**仓库
    BOM+LF 约定——Node/Python 的 `JSON.parse`/`json.load` 均拒绝 BOM）。
  - 文件结构：含 `schemaVersion: "1"`、`conversationId`、`turnId`、`updatedAt`、
    `messages[]`、`truncated`（含 `isTruncated`、`evictedTurns`、`evictedChars`）。
  - 并发与原子写：同目录临时文件 + rename 替换落位；同实例内对同一 `conversationId` 的
    历史读写操作在内存中排队串行化。
- **大小上限与自防御策略**（默认值，可用环境变量覆盖）：
  - **锚点保护与防膨胀**：每个会话的第一条用户消息（任务简报）标记为锚点，正常剔除时不予删除。
    但为防止极端大简报挤占后续对话空间，锚点正文设软上限（默认 4000 token / 16KB）；超出部分
    中间日志在沉淀入历史时提示折叠，确保至少为动态多轮预留 60% 上下文空间。
  - 窗口容量：默认保留最近 20 轮（`SESSBRIDGE_HISTORY_MAX_TURNS=20`）；
  - Token 预算：默认约 24000 token（`SESSBRIDGE_HISTORY_MAX_TOKENS=24000`；字符数/4 保守估算）；
  - **智能 assistant 压缩**：默认开（`SESSBRIDGE_HISTORY_COMPRESS_ASSISTANT=1`；当
    `noCompress: false` 且输出 > 2000 字符时压缩为“头 200 + 尾 500 + `\n...[truncated]...\n`”；
    若包含未闭合代码块标记，自动修补闭合标记以防 LLM 语法幻觉；零额外调用、完全确定）；
  - **LLM 摘要压缩**：默认关（`SESSBRIDGE_HISTORY_SUMMARIZE=0`；开启后中段由一次额外模型调用
    浓缩成 1–2 句并入上下文）；
  - 磁盘上限：单文件 ≤ 1MB。
- **剔除策略（Head + Tail）**：
  - 超出预算时从最旧的**非锚点**消息开始逐轮移除（保留头部任务简报 + 尾部最新工作状态，牺牲中段）；
  - **非静默删除**：在 `truncated` 元数据中累计 `evictedTurns`/`evictedChars`，并透传回执；
  - 归档：被剔除的完整历史增量追加至 `history_<cid>.archive.json`（**不发给模型**，仅供离线审计，
    保留期默认 7 天）。
- **重置与清理**：
  - 新会话：新 `conversationId` 即全新空白会话；
  - 显式重置：在命令中置 `resetHistory: true`，扩展清空该会话历史并以当前消息作为新锚点重启；
  - 客户端生命周期管理：CLI 提供显式会话管理能力（支持查询/导出快照/立即清空）。
- **可观测性与回执透出**：
  - 回执 `res_<pid>.json` 增加 `history` 结构（见 §4.2），透出 `totalTurns`、`inputTokensEst`、
    `isTruncated`、`evictedTurns`；
  - 扩展诊断文件 `diag_<pid>.json` 增设 `historyStats`。
- **边界与实现纪律**：
  - 与 visible 面板会话严格物理隔离；
  - 冻结本节规范后，依次构建黄金样例（多轮事实引用/重试防重/失败回滚/截断回显）与契约测试，
    再行进入扩展端与客户端实现。

### 5.2 人工回复受控通道（M2，`humanReply`）

- **背景（S0 结论）**：`vscode.chat.requestHandler` 与 `vscode.chat.sendRequest` 在当前
  VS Code/Copilot 版本**不存在**，无法全量静默捕获面板回复；因此 `visible` 双向的人工回复
  采用**受控 participant 通道**（S0 已验证 `vscode.chat.createChatParticipant` ✅）。
  未来若宿主 API 提供全量捕获能力，再评估升级（不退化为 GUI 自动化）。
- **参与方**：扩展注册 Chat Participant `sessbridge.review`
  （`vscode.chat.createChatParticipant`，经聊天工具适配器接缝），提示语说明触发格式。
- **触发**：人工在聊天面板输入
  `@sessbridge.review <conversationId> <回复内容>`；handler 解析 `conversationId` 并校验
  该会话存在/活跃（fail-close：未提供或无效时在面板给出明确错误提示，不做猜测关联）。
- **回复文件**：通道目录内 `reply_<conversationId>.json`（运行时文件：UTF-8 无 BOM + LF，
  原子写（临时文件 + rename）；与 `cmd_/res_/diag_/history_` 同目录同约定）：

```json
{
  "schemaVersion": "1",
  "conversationId": "prfrail-review-1",
  "turnId": 3,
  "humanReply": "同意",
  "requestId": "sess-...（若可关联，否则空串）",
  "reviewedAt": "2026-09-05T00:00:00Z",
  "extensionVersion": "0.1.0"
}
```

- **消费**：`wait --conversation-id <cid>`（M2 语义）轮询并读取该文件，回填到回执的
  `humanReply` 字段；`--keep` 保留，默认读取后删除。`reply` 子命令语义不变（v1 透传）。
- **生命周期**：与回执文件同保留期（默认 24h），由扩展 stale 清理统一回收；
  面板侧回复不重复投递到 `res_<pid>.json` 单槽，避免与并发回执竞争。
- **边界**：仅 `visible` 双向回合产生；silent 无人工参与。内容仍执行“调用方约定”安全策略
  （扩展不做脱敏，原样透传）。
- **验收**：人工面板输入 `@sessbridge.review <cid> <回复>` → `reply_<cid>.json` 出现 →
  客户端 `wait --conversation-id <cid>` 拿到 `humanReply` 非空 → 人工审核/确认端到端 PASS。

## 6. 旧协议兼容模式

- 兼容识别：`legacy=true` 或通道文件使用 whois 旧名
  `vscode_chat_send_cmd_<pid>.json` / `vscode_chat_send_res_<pid>.json`（及无 PID 的共享旧名）。
- 语义：与 whois 现有实现等价（模式、优先级、requestId 绑定、轮询/超时、发现模式
  `--discover` 允许空 message、PS/Python 对等退出码 0/1/2/3）。
- 验收：whois 现有 `Send-IpcChatMessage.ps1` / `ipc_chat_sender.py` 回归在兼容模式下全部通过，
  whois A/B 流程无需修改即可继续使用。

## 7. 与 ProofRail（证轨）的边界

- ProofRail 正式协议只声明并消费：`silent` 消息层 + 文件队列通道，用于可编程、可自动验收的
  无人值守投递。
- `visible` 会话级双向/人工交互属于 **SessionBridge 产品能力**，不进入 ProofRail 正式协议；
  ProofRail 与 SessionBridge 通过同一消息信封（第 4.1 节）松耦合，由 ProofRail 侧按任务策略
  选择模式与评审机制。
- 本 RFC 是通道契约的单一权威；ProofRail 侧 RFC 修订（§9.7/§11 adapter 协议）在本协议 v1
  冻结后的 M2 阶段同步。

## 8. 跨平台客户端策略

- **主实现：Python 3**（stdlib 为主）：`sessbridge send|wait|reply|discover`；
  行为在 Windows/Linux/macOS 一致；whois 既有 `ipc_chat_sender.py` 的契约（错误码、发现模式、
  requestId 生成、结果绑定）1:1 继承。
- **兼容层：PowerShell**（`sessbridge.ps1`，由 whois `Send-IpcChatMessage.ps1` 迁移/薄封装）：Windows 无缝接入，
  供 whois 现有调用脚本逐步切换；与 Python 实现通过同一契约测试锁定，禁止漂移。
- Go 单二进制 CLI 列为后续可选（M3+），引入前必须先通过契约等价测试。
- 双实现防漂移：黄金样例（命令/回执/错误码/多实例/优先级/超时）由契约测试统一驱动。

## 9. 安全边界（首版）

- 本地单用户威胁模型；通道目录默认在用户临时目录，**不宣称强隔离/沙箱**。
- 消息不可包含机密凭据——这是**调用方约定**，当前实现不做任何脱敏处理：诊断文件
  （`diag_*.json`）与回执（`res_*.json`）均**原样透传** `message`/`response`/环境元信息
  （版本、PID、API 可用性等），不做正则扫描或屏蔽。若调用方需要脱敏保证，须在写入
  消息前自行处理；本仓库暂无该能力的验收测试或黄金样例。
- 多实例路由基于 PID 校验；防止跨用户串扰（通道目录需按用户隔离）。
- 陈旧命令/结果文件主动清理；原子写 + 独占写避免读写竞争。
- 扩展权限最小化：只读自身 ppid 匹配的通道文件、只写自身结果文件。

## 10. 实施阶段（摘要）

| 阶段 | 交付 | 验收 |
|---|---|---|
| S0 | VS Code Chat API 双向能力 spike、模式语义冻结、能力矩阵 | 能力矩阵明确；降级路线确认 |
| M1 | extension + Python/PS 客户端 + installer + 旧协议兼容模式 | whois 既有回归全过；契约测试全过 |
| M2 | `conversationId/turnId/humanReply` 会话回合、契约测试扩展 | 人工审核/确认端到端 PASS |
| M3 | 发布：vsix + 客户端包 + SHA256 + 兼容矩阵 + CI（GitHub 公开 + Gitee 镜像） | 三平台客户端回归 PASS |
| M4 | whois 侧调用脚本切换（旧实现保留过渡期） | whois 等价验证 PASS |

## 11. 开放问题

1. `visible` 双向的人工回复捕获（已定：S0 结论 → 受控 `@sessbridge.review` participant
   通道，见 §5.2）。
2. 通道目录的默认位置与多用户隔离细则——S0/M1 定。
3. Python 客户端包名（PyPI `sessbridge` 待确认）与发布渠道。
4. whois 侧切换时机（M4）与旧实现保留时长。
