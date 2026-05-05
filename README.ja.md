[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# bitable-mesh

Lark Bitable 上での非同期人間-AI コラボレーションシステム。

> **⚠️ 免責事項**: 本プロジェクトは初期開発段階です。本番環境での使用には適していません。API は変更される可能性があり、データの安全性と安定性は十分に検証されていません。

---

## アーキテクチャ

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
                                 │ Executor │ (複数インスタンス)
                                 └──────────┘
```

| ロール | CLI | 役割 |
|:---|:---|:---|
| **Channel** | `channel` | Lark IM を WebSocket でリッスン、チケット作成、オプションで LLM による完全性チェック、返信を配信 |
| **Executor** | `join` | 保留中チケットをポーリング、ソフトプリエンプションで獲得、Claude を実行、結果を書き戻し |
| **Direct** | `direct` | ステートレスモード: IM → Claude → 返信、テーブル不使用 |

Channel と Executor は同一マシンでも異なるマシンでも、どのネットワークでも実行可能——Lark API に到達できれば動作します。

---

## インストール

```bash
npm install -g @typooo/bitable-mesh
```

Node.js >= 18 および [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI が必要です。

---

## クイックスタート

### 1. Lark アプリの作成

[Lark Developer Console](https://open.larksuite.com/app) で**カスタムアプリ**を作成:

- 機能を追加: **Bitable** (権限: `bitable:app`)
- IM ボットの場合: **Bot** を追加、権限 `im:message` と `im:message:send_as_bot`、`im.message.receive_v1` イベントを購読

### 2. セットアップ

```bash
bitable-mesh setup
```

ガイド付きウィザード: サーバー選択 → appId (必須) + appSecret (Channel のみ) を入力 → テーブルの自動作成または既存テーブルに紐付け → 編集権限を自動付与 → プロファイルとして保存。

設定は `~/.bitable-mesh/profiles/default.toml` に保存されます。

### 3. ログイン (Executor のみ)

```bash
bitable-mesh login
```

OAuth PKCE フロー — ブラウザで確認するだけで Lark の ID が自動的に収集されます。

### 4. 起動

```bash
# Executor (チケット処理)
bitable-mesh join

# Channel (IM ボット、appSecret が必要)
bitable-mesh channel
```

---

## 動作の仕組み

1. ユーザーが Lark ボットに DM を送信
2. **Channel** が下書きチケットを作成し、ユーザーメッセージを追加
3. `useLLM=true` の場合、Channel が Claude に情報の完全性を評価させ、不足があれば追加質問
4. 準備が整うと、Channel が `pending` に昇格
5. **Executor** が保留中チケットをポーリングし、ソフトプリエンプションで獲得
6. オプションの**実行前承認** — 承認者（Bitable 自動化経由）の確認を待機
7. Executor が Claude Code を実行
8. オプションの**回答後レビュー** — レビュー担当者が回答を承認するまで待機
9. 結果がテーブルに書き戻され、Channel が IM に配信

---

## タスク割り当て (Capabilities)

Executor は能力（capability）を宣言して専門化できます。Channel はユーザーメッセージを分類して適切な Executor に割り当てます。

### Executor 設定

```toml
[executor]
capabilities = ["tech_support", "hr"]
```

### 分類モード

| モード | 設定 | 説明 |
|:---|:---|:---|
| キーワード | `capabilitiesMapping = "keyword"` | Capabilities テーブルのキーワードとマッチング |
| スラッシュコマンド | `capabilitiesMapping = "command"` | ユーザーが `/tech_support 質問` と明示的に指定 |

### Capabilities テーブル

| フィールド | 型 | 説明 |
|:---|:---|:---|
| capability | テキスト | 識別子、例: `tech_support` |
| display_name | テキスト | 表示名 |
| keywords | テキスト | カンマ区切りのキーワード |
| prompt | テキスト | ドメイン固有のシステムプロンプト (オプション) |
| enabled | チェックボックス | 有効 |

---

## Human-in-the-Loop

### 実行前承認

Executor の Roster レコードに `human` フィールド（Person 型）を設定します。チケット獲得後、Executor は承認フェーズに入ります。担当者が設定されていない場合はスキップされます。

```
獲得 → pending_approval → 承認 → Claude 実行 → 完了
                        → 却下 → pending に戻る
```

スキップ: `bitable-mesh join --skip-approval`

### 回答後レビュー

```toml
[executor]
postReview = true
```

回答は `pending_review` として書き込まれます。レビュー担当者が `approved` にマークした場合のみ、Channel が IM に配信します。

---

## 設定リファレンス

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
システムプロンプトをここに...
"""
```

---

## CLI リファレンス

```bash
bitable-mesh [options] <command>
```

| コマンド | 説明 |
|:---|:---|
| `setup` | インタラクティブ設定ウィザード |
| `login` | OAuth PKCE ログイン |
| `join` | Executor を起動 (自動ログイン) |
| `channel` | Channel を起動 (IM ボット) |
| `direct` | ステートレスモード |

| オプション | 説明 |
|:---|:---|
| `-p, --profile <n>` | プロファイル名 (デフォルト `default`) |
| `-v` | デバッグログを有効化 |
| `--skip-approval` | 実行前承認をスキップ |

---

## プロジェクト構成

```text
src/
├── cli.ts       エントリポイント
├── channel.ts   Channel: WS、メッセージ、下書き、配信
├── executor.ts  Executor: ポーリング、獲得、Claude 処理
├── protocol.ts  Session: Bitable CRUD、状態遷移
├── processor.ts Claude サブプロセス
├── bitable.ts   Lark API クライアント
├── config.ts    設定読み込み (TOML)
├── setup.ts     セットアップウィザード
├── auth.ts      OAuth PKCE
├── log.ts       ロガー
└── types.ts     型定義
```

---

## 制限事項

- ソフトプリエンプションには競合ウィンドウがあります
- ポーリング遅延は `pollInterval` に依存します
- Bitable にサーバーサイド CAS はなく、クライアントの規律に依存します
- 承認・レビュー通知は Bitable 自動化に依存します

## ライセンス

MIT
