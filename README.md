[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# bitable-mesh

Asynchronous human-AI collaboration on Lark (Feishu) Bitable.

> **⚠️ Disclaimer**: This project is in early development. It is not suitable for production use. APIs may change, and data safety and stability have not been fully validated.

---

## Architecture

```
Lark IM
    │
    ▼
┌──────────┐  draft → pending    ┌──────────┐
│ Channel  │ ──────────────────▶ │ Bitable  │ ◀── poll / claim / write
│          │ ◀──── deliver ───── │ (tables) │
└──────────┘                     └──────────┘
                                      ▲
                                      │
                                 ┌──────────┐
                                 │ Executor │ (multiple instances)
                                 └──────────┘
```

| Role | CLI | What it does |
|:---|:---|:---|
| **Channel** | `channel` | Listens for Lark IM via WebSocket, creates tickets, optional LLM completeness check, delivers replies |
| **Executor** | `join` | Polls for pending tickets, claims via soft preemption, runs Claude, writes results |
| **Direct** | `direct` | Stateless mode: IM → Claude → reply, no tables used |

Channel and Executor can run on the same machine or different machines, in any network — they only need to reach Lark APIs.

---

## Install

```bash
npm install -g @typooo/bitable-mesh
```

Requires Node.js >= 18 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

---

## Quick Start

### 1. Create Lark App

Create a **custom app** in [Lark Developer Console](https://open.larksuite.com/app):

- Add capability: **Bitable** (permission: `bitable:app`)
- For IM bot: add **Bot**, permissions `im:message` and `im:message:send_as_bot`, subscribe to `im.message.receive_v1`

### 2. Setup

```bash
bitable-mesh setup
```

Guided wizard: choose server → enter appId (required) + appSecret (for Channel only) → create or link tables → auto-grant edit access → save as profile.

Config stored at `~/.bitable-mesh/profiles/default.toml`.

### 3. Login (Executor only)

```bash
bitable-mesh login
```

OAuth PKCE flow — browser confirmation collects your Lark identity automatically.

### 4. Start

```bash
# Executor (processes tickets)
bitable-mesh join

# Channel (IM bot, needs appSecret)
bitable-mesh channel
```

---

## How It Works

1. User DMs the Lark bot
2. **Channel** creates a draft ticket and appends the user message
3. If `useLLM=true`, Channel asks Claude to assess completeness; asks follow-up if needed
4. When ready, Channel promotes to `pending`
5. **Executor** polls for pending tickets, claims via soft preemption
6. Optional **pre-execution approval** — waits for a human approver (via Bitable automation)
7. Executor runs Claude Code
8. Optional **post-answer review** — waits for a reviewer to approve the answer
9. Results written back, Channel delivers to IM

---

## Task Assignment (Capabilities)

Executors can specialize by declaring capabilities. Channel classifies user messages to match them.

### Executor Config

```toml
[executor]
capabilities = ["tech_support", "hr"]
```

### Classification Modes

| Mode | Config | Description |
|:---|:---|:---|
| Keywords | `capabilitiesMapping = "keyword"` | Matches keywords from the Capabilities table |
| Slash Commands | `capabilitiesMapping = "command"` | User types `/tech_support my issue` |

### Capabilities Table

| Field | Type | Description |
|:---|:---|:---|
| capability | Text | Identifier, e.g. `tech_support` |
| display_name | Text | Display name |
| keywords | Text | Comma-separated keywords |
| prompt | Text | Domain-specific system prompt (optional) |
| enabled | Checkbox | Enabled |

---

## Human-in-the-Loop

### Pre-execution Approval

Set the `human` field (Person type) on the Executor's Roster record. After claiming a ticket, the Executor enters approval. No human configured = skip.

```
claimed → pending_approval → approved → run Claude → done
                            → rejected → back to pending
```

Skip: `bitable-mesh join --skip-approval`

### Post-answer Review

```toml
[executor]
postReview = true
```

Answers are written as `pending_review`. Channel delivers only when a reviewer marks it `approved`.

---

## Config Reference

```toml
appId = "cli_xxx"
openApiDomain = "open.larksuite.com"
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
System prompt goes here...
"""
```

---

## CLI Reference

```bash
bitable-mesh [options] <command>
```

| Command | Description |
|:---|:---|
| `setup` | Interactive config wizard |
| `login` | OAuth PKCE login |
| `join` | Start Executor (auto-login) |
| `channel` | Start Channel (IM bot) |
| `direct` | Stateless mode |

| Option | Description |
|:---|:---|
| `-p, --profile <n>` | Profile name (default `default`) |
| `-v` | Enable debug logging |
| `--skip-approval` | Skip pre-execution approval |

---

## Project Structure

```text
src/
├── cli.ts       Entry point
├── channel.ts   Channel: WS, messages, drafts, delivery
├── executor.ts  Executor: polling, claiming, Claude processing
├── protocol.ts  Session: Bitable CRUD, state transitions
├── processor.ts Claude subprocess
├── bitable.ts   Lark API client
├── config.ts    Config loading (TOML)
├── setup.ts     Setup wizard
├── auth.ts      OAuth PKCE
├── log.ts       Logger
└── types.ts     Types
```

---

## Limitations

- Soft preemption has a race window
- Polling latency bounded by `pollInterval`
- No Bitable server-side CAS — relies on client discipline
- Approval/review notifications depend on Bitable automation

## License

MIT
