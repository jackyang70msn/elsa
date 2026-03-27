# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案簡介

Elsa 是 Claude Code 的 Telegram & Discord 橋接工具，讓使用者能從手機透過 Telegram 或 Discord 操控 Claude Code。開發機器上只需執行一個 daemon 程序，透過 long polling 連接平台（不需要伺服器或公開網址）。採用**單 Bot 多 Repo 架構**：一個 worker bot 可管理多個專案目錄，透過 `/repo switch` 切換。

## 常用指令

```bash
# 開發
npm install          # 安裝依賴
npm start            # 直接執行 daemon（使用 tsx，不需 build）
npm run dev          # 監視模式（檔案異動自動重啟）
npm run cli          # 執行 CLI 指令（例如 npx tsx src/cli.ts setup）

# 建置與驗證
npm run build        # 編譯 TS → dist/，設定可執行權限
npx tsc --noEmit     # 僅做型別檢查（CI 會執行此步驟）
npm test             # 執行所有測試（node:test 測試器）

# 執行單一測試檔案
node --import tsx --test tests/formatter.test.ts

# Windows 快速啟動
setup.bat            # 首次設定（安裝依賴 + 互動式設定 Telegram/Discord）
start.bat            # 一鍵啟動 daemon
```

CI 流程：型別檢查 → 測試 → 建置（於 Node 18、20、22 上執行）。

## 架構

```
Daemon (daemon.ts)
├── Discord Manager (discord-manager.ts) — /add、/remove、/bots 指令（Discord）
├── Telegram Manager (manager.ts) — /add、/remove、/bots 指令（Telegram）
├── Discord Worker Bot × N (discord-worker.ts) — 單 Bot 多 Repo
│   └── BridgeRouter (bridge-router.ts) — chatId → repo 路由
│       └── ClaudeBridge × N (claude.ts) — 每個 repo 一個 Claude CLI 實例
├── Telegram Worker Bot × N (worker.ts) — 每個專案 repo 一個
│   └── ClaudeBridge (claude.ts) — spawn 本地 claude CLI（stream-json 模式）
├── Scheduler (scheduler.ts) — 基於 cron 的排程 Claude 查詢
└── Tunnel (tunnel.ts) — ngrok 隧道用於 /preview
```

### BridgeRouter（bridge-router.ts）— Repo 路由層（v3.0.0 新增）

- 管理多個 `ClaudeBridge` 實例，每個 repo 一個
- `chatId → repoAlias` 映射，支援 `/repo switch` 切換
- 每個 repo 的 state 獨立存放在 `<repo>/.elsa/state.json`
- 切換 repo 後保留原 session（不會重新建立）
- 提供 `addRepo()`、`removeRepo()`、`switchRepo()`、`listRepos()` 等 API

### RepoManager（repo-manager.ts）— Repo 設定持久化（v3.0.0 新增）

- `~/.elsa/repos.json` 儲存所有已註冊的 repo（path + alias + addedAt）
- CRUD 操作：`addRepo()`、`removeRepo()`、`getRepoByAlias()`
- 自動在 repo 目錄建立 `.elsa/` 子目錄並加入 `.gitignore`
- alias 自動從目錄名衍生，重複時加數字後綴

### ClaudeBridge（claude.ts）— 核心元件

- 透過 `spawn('claude', ['--print', '--output-format', 'stream-json', ...])` 呼叫本地 Claude Code CLI
- 使用 `--dangerously-skip-permissions` 自動核准所有工具
- stdout 逐行 `readline` 解析 JSON，非 JSON 行靜默忽略
- 所有 UI 互動透過 `SendCallbacks` 回呼介面傳遞，與平台層完全解耦
- **重要**：spawn 時會剝除 `CLAUDECODE` 環境變數（`cleanEnv`），讓 daemon 在 Claude Code session 內啟動時子程序不會拒絕執行
- 支援 `stateDir` 參數，允許 per-repo 獨立 state 儲存
- query 結束後有 2 秒冷卻期（`isCoolingDown()`）防止連打

### Discord Worker Bot（discord-worker.ts）— 訊息處理

- 串流顯示：`editMessageText`（1500ms debounce），支援 Thinking... 初始訊息
- 檔案/圖片下載到 `os.tmpdir()/elsa-{botId}/`，路徑注入 prompt 讓 Claude 自己讀取
- `/repo` 指令：`add`、`list`、`switch`、`remove` — 管理多個專案目錄
- 回覆結尾顯示 token 統計 + 當前 repo 名稱
- 所有 callback query 資料格式：`action:id` 或 `action:sub:id`

### Telegram Worker Bot（worker.ts）— 訊息處理

- 串流顯示雙軌策略：DM 使用 `sendMessageDraft`（300ms debounce），群組/備用使用 `editMessageText`（1500ms debounce），失敗時自動降級
- 檔案/圖片下載到 `os.tmpdir()/elsa-{botId}/`，路徑注入 prompt 讓 Claude 自己讀取，query 結束後清理
- 所有 callback query 資料格式：`action:id` 或 `action:sub:id`（如 `approve:3`、`plan:approve:5`、`answer:2:1`）
- Pending 狀態用 Map 管理，每種操作有獨立 timeout（工具核准 2 小時、ngrok/排程確認 5 分鐘）
- 回覆上下文：`extractReplyContext()` 截斷 500 字元，加 `[Replying to message: "..."]` 前綴

### Formatter（formatter.ts）— Markdown 轉換

- `claudeToTelegram()`：兩階段替換，先用 `\x00` 佔位符提取 block/inline 元素，再處理 inline 格式，防止雙重轉義
- `claudeToDiscord()`：轉換 Claude 輸出為 Discord 格式
- `splitMessage()` / `splitDiscordMessage()`：智慧分割至平台字數上限，追蹤標籤堆疊

### Daemon（daemon.ts）— 生命週期

- 啟動順序：PID 檔 → ScheduleManager → manager bot → 恢復 workers → 恢復排程 → 健康檢查 timer
- Discord workers 啟動時自動從 `repos.json` 載入 repo 清單，無 repo 時以 `workingDir` 作為 fallback
- 409 Conflict 重試：最多 3 次，每次等待 `15s × attempt`，涵蓋 Telegram 30s 長輪詢超時
- 健康檢查（每 5 分鐘）：`getMe()` 測試 → 重啟 dead workers → 啟動設定中缺失的 bot（2 分鐘冷卻防快速重啟循環）
- 優雅停機：停止 health check → 停止排程 → abortAll() → 關閉 tunnels → 停止 bots → 刪除 PID 檔

### 其他模組

- **Scheduler（scheduler.ts）**：用 Claude Haiku + `execFile` 解析自然語言為 cron 表達式；執行時強制新會話、`maxTurns: 25`、自動核准所有工具
- **Tunnel（tunnel.ts）**：每個 chatId 最多一個 ngrok tunnel，30 分鐘不活躍自動關閉
- **Config（config.ts）**：環境變數 > `~/.elsa/config.json`，支援 Telegram + Discord 雙平台設定
- **Log（log.ts）**：TTY 彩色格式化輸出（`[botname] TOOL ...`），非 TTY 輸出 JSON Lines；達 5MB 自動輪轉

## 關鍵模式

**儲存** — 全部位於 `~/.elsa/`，權限 `0600`：
- `config.json` — bot 令牌（Telegram + Discord）、owner ID、ngrok 令牌
- `bots.json` — Telegram worker bot 設定
- `discord-bots.json` — Discord worker bot 設定
- `repos.json` — 已註冊的 repo 清單（path + alias）
- `schedules.json` — 排程任務
- `state-{botId}.json` — Telegram 會話 ID、token 使用量、已選模型
- `<repo>/.elsa/state.json` — Discord per-repo 狀態（會話 ID、模型等）

**安全性**：
- 所有指令都有 owner ID 守衛（Telegram: `ctx.from?.id`，Discord: `interaction.user.id`）
- `spawn()` 使用陣列參數避免 shell 注入
- session ID 以嚴格 UUID regex 驗證
- API 呼叫用空 `catch {}` 防止崩潰（發送失敗不應中斷服務）

**ESM import 慣例**：import 路徑必須使用 `.js` 副檔名（ESM + NodeNext 要求），即使源碼是 `.ts`。

## Bot 指令一覽

### Worker Bot（Discord / Telegram）

| 指令 | 說明 |
|------|------|
| `/new` | 開始新 session（清除上下文） |
| `/model` | 切換 Claude 模型（Opus / Sonnet / Haiku） |
| `/cost` | 顯示當前 session 的 token 用量 |
| `/session` | 取得 session ID，可在 CLI 繼續 |
| `/resume <id>` | 在 bot 中恢復一個 CLI session |
| `/cancel` | 中止當前正在執行的操作 |
| `/help` | 顯示說明 |
| `/preview [port]` | 開啟 ngrok tunnel 預覽開發伺服器 |
| `/close` | 關閉 preview tunnel |
| `/schedule <task>` | 新增排程任務（自然語言，如 "daily 9am run tests"） |
| `/schedules` | 列出所有排程任務 |
| `/unschedule <number>` | 移除指定排程任務 |
| `/allow <user>` | 授權其他使用者使用此 chat（owner only） |
| `/deny <user>` | 移除使用者授權（owner only） |
| `/members` | 列出已授權的使用者（owner only） |

### Discord Worker Bot 額外指令

| 指令 | 說明 |
|------|------|
| `/repo add <path> [alias]` | 新增一個 repo 目錄 |
| `/repo list` | 列出所有已註冊的 repo |
| `/repo switch <alias>` | 切換到指定 repo |
| `/repo remove <alias>` | 移除指定 repo |
| `/mode` | 切換 Claude 權限模式（Bypass / Accept Edits / Plan） |

### Manager Bot（Discord / Telegram）

| 指令 | 說明 |
|------|------|
| `/add` | 新增一個 worker bot |
| `/remove <bot>` | 移除指定 worker bot（或 `all` 全部移除） |
| `/bots` | 列出所有活躍的 worker bot |
| `/schedules` | 查看所有 bot 的排程任務 |

### CLI 指令（`elsa <command>`）

| 指令 | 說明 |
|------|------|
| `setup` | 互動式設定 Telegram / Discord / 兩者 |
| `start` | 在背景啟動 daemon |
| `stop` | 停止 daemon |
| `status` | 查看 daemon 是否運行中 |
| `logs` | 即時追蹤 daemon log（Ctrl+C 結束） |
| `install-service` | 安裝為系統服務（macOS launchd / Linux systemd） |
| `uninstall-service` | 移除系統服務 |

## 程式碼風格

- TypeScript strict mode，ESM（`"type": "module"`）
- 目標 ES2022，模組系統 NodeNext
- 內建模組使用 `node:` 前綴（`node:fs`、`node:path` 等）
- 無 linter 設定 — 請配合周圍程式碼風格
- 函式簽名使用明確型別，區域變數可推斷
- 測試使用 `node:test` + `node:assert/strict`（無外部測試框架）
- 測試中動態 import 搭配 `process.env.HOME` 覆寫來隔離檔案系統

## 主要依賴

- `grammy` — Telegram bot 框架
- `discord.js` — Discord bot 框架
- `@ngrok/ngrok` — 隧道管理用於即時預覽
- `node-cron` — 排程任務執行
- 本地 `claude` CLI — 透過 spawn 子進程整合（需先安裝並認證 Claude Code CLI）
