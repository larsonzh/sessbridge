# SessionBridge / 会话桥

> *A two-way session bridge between VS Code Copilot Chat and external automation.*
> 外部自动化与 VS Code Copilot Chat 之间的双向会话桥。

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
  兼容层保留 Windows 无缝接入）+ `installer/`（安装/更新/卸载）。

## 命名记录（RFC 惯例）

- **ChatBridge / chatbridge 不可用**：USPTO 注册商标 CHATBRIDGE（ARI Network Services, Inc.，
  注册号 88962890）、商业产品 ChatBridge AI、GitHub 同类项目 `ylexLiao/chatbridge` 与
  `HARIOM8859/ChatBridge-Extension`、Chrome Web Store 同名扩展。
- **DialogBridge / dialogbridge 候选**：可用，但名称较长；**DlgBridge / dlgbridge** 缩写候选
  亦可用（GitHub/仓库/npm 均未占用），但辨识度一般，未采用。
- 采用 **SessionBridge / `sessbridge` / 会话桥**：GitHub 用户/组织 404、仓库检索 0、
  npm 404，全部未占用；语义贴合“会话级双向交互”。
- **简称纪律**：不用 `sb`（中文互联网语境存在不雅联想）；内部建议 `sess` 或 `sbr`。

## 仓库结构（计划）

```
extension/   VS Code 扩展（visible/silent/auto、多实例路由、会话回合、旧协议兼容模式）
client/      Python 3 跨平台客户端（sessbridge send/wait/reply/discover）；PowerShell 兼容层
installer/   安装/更新/卸载脚本与 vsix 打包
docs/        通道协议 v1 规范、兼容矩阵、能力矩阵
```

## 协议

权威规范：[docs/RFC-sessbridge-channel-protocol-v1.md](docs/RFC-sessbridge-channel-protocol-v1.md)

边界说明：ProofRail（证轨）正式协议仅消费 `silent` 通道与文件队列；`visible` 人工交互属于
SessionBridge 产品能力，不进入 ProofRail 正式协议。

## 许可证

MIT（Copyright (c) 2026 larsonzh）

## 发布计划

- GitHub 公开仓库 + **Gitee 镜像备份**。
- 发布物：vsix + 跨平台客户端包 + SHA256 + 兼容矩阵 + 独立 CI。
