[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# bitable-mesh

基于飞书多维表格的异步人机协作系统。

> **⚠️ 免责声明**：本项目处于早期开发阶段，当前版本不适合在生产环境中使用。API 可能变更，数据安全性和稳定性尚未得到充分验证。

---

## 架构

```
用户 (飞书 IM)
    │
    ▼
┌──────────┐  draft → pending    ┌──────────┐
│ Channel  │ ──────────────────▶ │ Bitable  │ ◀── poll / claim / write
│          │ ◀──── deliver ───── │ (tables) │
└──────────┘                     └──────────┘
                                      ▲
                                      │
                                 ┌──────────┐
                                 │ Executor │ (多个实例)
                                 └──────────┘
```

| 角色 | CLI 命令 | 职责 |
|:---|:---|:---|
| **Channel** | `channel` | 监听飞书 IM，创建工单，可选 LLM 完整性检查，投递回复 |
| **Executor** | `join` | 轮询 pending 工单，软抢占认领，调用 Claude 处理，写回结果 |
| **Direct** | `direct` | 无状态模式：消息直达 Claude → 回复，不写表 |

Channel 和 Executor 可在同一或不同机器运行，只需都能访问飞书 API。

---

## 安装

```bash
npm install -g @typooo/bitable-mesh
```

依赖：Node.js >= 18，且需要安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI。

---

## 快速开始

### 1. 创建飞书应用

在[飞书开发者后台](https://open.feishu.cn/app)创建**企业自建应用**：

- 添加能力：**多维表格**（权限：`bitable:app`）
- 如需 IM 功能，添加**机器人**能力，权限含 `im:message`、`im:message:send_as_bot`，订阅 `im.message.receive_v1` 事件

### 2. 初始化配置

```bash
bitable-mesh setup
```

交互引导：选服务器 → 填 appId（必填）/ appSecret（Channel 才需要）→ 自动建表或关联已有表格 → 授予编辑权限 → 保存为 profile。

配置存于 `~/.bitable-mesh/profiles/default.toml`。

### 3. 登录

```bash
bitable-mesh login
```

OAuth PKCE 授权，浏览器确认后自动收集你的飞书身份并写入配置。

### 4. 启动

```bash
# Executor（处理工单）
bitable-mesh join

# Channel（IM 机器人，需要 appSecret）
bitable-mesh channel
```

---

## 工作流程

1. 用户飞书私聊 Bot
2. **Channel** 创建 draft 工单，写入用户消息
3. `useLLM=true` 时 Channel 调 Claude 检查信息完整度，不足则追问
4. 信息就绪 → 提升为 `pending`
5. **Executor** 轮询到 pending 工单，软抢占认领
6. 可选**执行前审批**：需负责人通过多维表自动化确认
7. Executor 调 Claude Code 处理
8. 可选**回答后审核**：审核人确认后投递
9. 结果写回表格，Channel 投递到 IM

---

## 任务分配（Capabilities）

多个 Executor 可按领域分工。

### Executor 配置

```toml
[executor]
capabilities = ["tech_support", "hr"]
```

仅认领 `required_capabilities` 匹配的工单（无则认领所有）。

### 能力分类

Channel 在创建工单时自动分类用户消息，写入 `required_capabilities`。两种方式：

| 方式 | 配置 | 说明 |
|:---|:---|:---|
| 关键词 | `capabilitiesMapping = "keyword"` | 在 Capabilities 表中配置关键词，Channel 匹配 |
| 斜杠命令 | `capabilitiesMapping = "command"` | 用户 `/tech_support 我的问题` 显式指定 |

### Capabilities 表

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| capability | 文本 | 标识，如 `tech_support` |
| display_name | 文本 | 展示名称 |
| keywords | 文本 | 逗号分隔的关键词 |
| prompt | 文本 | 该领域的专用提示词（可选） |
| enabled | 复选框 | 是否启用 |

---

## 人在回路

### 执行前审批

在 Roster 表中为 Executor 记录设置 `human` 字段（人员类型），Executor 认领工单后自动进入审批。未设置负责人则跳过。

1. 状态 → `pending_approval`
2. 通知负责人（依赖多维表自动化）
3. 批准 → 继续；驳回 → 释放

跳过：`bitable-mesh join --skip-approval`

### 回答后审核

```toml
[executor]
postReview = true
```

AI 回答写为 `pending_review`，审核人批准后 Channel 投递到 IM。

---

## 配置参考

```toml
appId = "cli_xxx"
openApiDomain = "open.feishu.cn"
appToken = "QBX..."
ticketsTableId = "tbl..."
turnsTableId = "tbl..."
rosterTableId = "tbl..."
capabilitiesWhitelistTableId = "tbl..."

[channel]
enabled = true
useLLM = false
capabilitiesMapping = "keyword"

[executor]
capabilities = []
skipApproval = false
approvalTimeoutMinutes = 30
postReview = false

prompt = """
系统提示词...
"""
```

> 字段映射和状态名有默认值，通常无需额外配置。默认值见 `config.ts` 的 `DEFAULT_FIELDS` / `DEFAULT_STATUSES`。

---

## CLI 参考

```bash
bitable-mesh [options] <command>
```

| 命令 | 说明 |
|:---|:---|
| `setup` | 交互式配置向导 |
| `login` | OAuth PKCE 登录 |
| `join` | 启动 Executor（自动 login） |
| `channel` | 启动 Channel |
| `direct` | 无状态模式 |

| 参数 | 说明 |
|:---|:---|
| `-p, --profile <n>` | 使用指定 profile（默认 default） |
| `-v` | 调试日志 |
| `--skip-approval` | join 时跳过审批 |

---

## 项目结构

```text
src/
├── cli.ts       CLI 入口
├── channel.ts   Channel：WS、消息处理、turn 投递
├── executor.ts  Executor：轮询、认领、Claude 处理
├── protocol.ts  Session：Bitable CRUD、状态转换
├── processor.ts Claude 子进程
├── bitable.ts   飞书 API 客户端
├── config.ts    配置加载（TOML）
├── setup.ts     安装向导
├── auth.ts      OAuth PKCE
├── log.ts       日志
└── types.ts     类型定义
docs/
└── internal-design.md   内部设计文档
```

---

## 局限

- 软抢占有竞争窗口
- 轮询延迟受 `pollInterval` 影响
- Bitable 无 CAS，防脏写依赖客户端自律
- 审批/审核通知依赖多维表自动化或外部编排

## License

MIT
