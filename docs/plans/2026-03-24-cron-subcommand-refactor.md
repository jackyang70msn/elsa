# /cron Subcommand Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 將 `/schedule`, `/schedules`, `/unschedule` 三個獨立指令重構為 `/cron add|list|del` 子命令結構，兩平台統一。

**Architecture:** 遵循既有 `/repo add|list|switch|remove` 的 subcommand 模式。Discord 使用 `SlashCommandBuilder.addSubcommand()`，Telegram 使用單一 `bot.command("cron")` 搭配手動子命令解析。callback query data 前綴從 `schedule:` 更名為 `cron:`。

**Tech Stack:** TypeScript, grammy (Telegram), discord.js (Discord), node-cron

---

## Scope

### P0 (必須)
- Discord slash command 改為 `/cron add|list|del` subcommand
- Discord 文字指令改為 `/cron add|list|del`
- Telegram 指令改為 `/cron add|list|del`
- Callback query data 前綴更新
- WORKER_COMMANDS 更新
- Help 文字更新

### P1 (重要)
- Manager bot `/schedules` 指令更名（可保持不動，因為它是管理層面的「查看全部排程」）

### Out of Scope
- ScheduleManager 內部邏輯不動
- Schedule 資料結構不動
- scheduler.ts 不動（除了 help 文字）
- 排程執行 (daemon.ts runCallback) 不動

---

## Contracts (LOCKED)

- **C1-COMMAND**: 使用者指令統一為 `/cron add <task>`、`/cron list`、`/cron del <number>`
- **C2-COMPAT**: 舊的 `schedules.json` 資料格式不變，已建立的排程繼續運作
- **C3-PATTERN**: Discord slash command 必須使用 `addSubcommand()` 模式，與 `/repo` 一致
- **C4-CALLBACK**: callback query data 格式更新為 `cron:confirm:<id>` / `cron:cancel:<id>`
- **C5-NOBREAK**: 不修改 ScheduleManager、Schedule interface、scheduler.ts 核心邏輯

---

## Interfaces (LOCKED)

### 使用者指令
| 舊指令 | 新指令 | 說明 |
|--------|--------|------|
| `/schedule daily 9am run tests` | `/cron add daily 9am run tests` | 新增排程 |
| `/schedules` | `/cron list` | 列出排程 |
| `/unschedule 2` | `/cron del 2` | 移除排程 |

### Callback Query Data
| 舊格式 | 新格式 |
|--------|--------|
| `schedule:confirm:{chatId}` | `cron:confirm:{chatId}` |
| `schedule:cancel:{chatId}` | `cron:cancel:{chatId}` |

---

## Definition of Done (DoD)

1. `npx tsc --noEmit` 通過
2. `npm test` 通過（60/61，Windows 權限測試除外）
3. `/cron add`, `/cron list`, `/cron del` 在 Discord 和 Telegram 皆可操作
4. 舊的 `/schedule`, `/schedules`, `/unschedule` 指令不再回應
5. 已建立的排程（schedules.json）不受影響

---

## Merge Gates

| Gate | 驗證方式 | Pass/Fail |
|------|---------|-----------|
| G1 | `npx tsc --noEmit` 零錯誤 | exit code 0 |
| G2 | `npm test` 60/61 通過 | 僅 Windows 權限測試可失敗 |
| G3 | grep 確認無殘留 `bot.command("schedule"` 或 `setName("schedule")` | 零匹配 |
| G4 | grep 確認 `"cron"` 指令已註冊 | 有匹配 |

---

## Implementation Tasks

### Task 1: daemon.ts — WORKER_COMMANDS 更新

**Files:**
- Modify: `src/daemon.ts:36-38`

**Step 1: 修改 WORKER_COMMANDS**

將三行：
```typescript
{ command: "schedule",   description: "Add a scheduled task" },
{ command: "schedules",  description: "List scheduled tasks" },
{ command: "unschedule", description: "Remove a scheduled task" },
```

替換為一行：
```typescript
{ command: "cron", description: "Manage scheduled tasks (add / list / del)" },
```

---

### Task 2: worker.ts — Telegram 指令重構

**Files:**
- Modify: `src/worker.ts`

**Step 1: 移除 3 個獨立指令，改為單一 `/cron` 指令**

移除 `bot.command("schedule", ...)`, `bot.command("schedules", ...)`, `bot.command("unschedule", ...)` 三個指令區塊（約 line 350-443）。

替換為一個 `bot.command("cron", ...)` 區塊，內部解析子命令：

```typescript
bot.command("cron", async (ctx) => {
  const chatId = ctx.chat.id;
  const args = ctx.match?.trim() || "";
  const spaceIdx = args.indexOf(" ");
  const subCmd = spaceIdx === -1 ? args.toLowerCase() : args.slice(0, spaceIdx).toLowerCase();
  const subArg = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

  if (subCmd === "add") {
    // 搬移原 bot.command("schedule") 的邏輯，input = subArg
  } else if (subCmd === "list") {
    // 搬移原 bot.command("schedules") 的邏輯
  } else if (subCmd === "del") {
    // 搬移原 bot.command("unschedule") 的邏輯，arg = subArg
  } else {
    // 顯示用法說明
    await ctx.reply(
      "<b>排程管理</b>\n\n" +
      "<code>/cron add [任務描述]</code> — 新增排程\n" +
      "<code>/cron list</code> — 列出排程\n" +
      "<code>/cron del [編號]</code> — 移除排程",
      { parse_mode: "HTML" }
    );
  }
});
```

**Step 2: 更新 callback query data 前綴**

在 `pendingScheduleConfirm.set()` 區塊中（原 line ~390-392）：
- `schedule:confirm:${chatId}` → `cron:confirm:${chatId}`
- `schedule:cancel:${chatId}` → `cron:cancel:${chatId}`

在 callback query handler 中（原 line ~1115-1153）：
- `data.startsWith("schedule:confirm:")` → `data.startsWith("cron:confirm:")`
- `data.startsWith("schedule:cancel:")` → `data.startsWith("cron:cancel:")`

**Step 3: 更新所有使用者面向文字**

- 所有 "Schedule" 相關的 UI 文字改為 "排程" 或保持對應中文
- `/schedule` 引用改為 `/cron add`
- `/schedules` 引用改為 `/cron list`
- `/unschedule` 引用改為 `/cron del`

---

### Task 3: discord-worker.ts — Discord Slash Command 重構

**Files:**
- Modify: `src/discord-worker.ts`

**Step 1: Slash command 定義重構**

移除 3 個獨立的 SlashCommandBuilder（原 line ~729-741），替換為單一 subcommand 結構：

```typescript
new SlashCommandBuilder()
  .setName("cron")
  .setDescription("Manage scheduled tasks")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a scheduled task")
      .addStringOption((opt) =>
        opt.setName("task").setDescription("e.g. daily 9am run tests").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List scheduled tasks")
  )
  .addSubcommand((sub) =>
    sub
      .setName("del")
      .setDescription("Remove a scheduled task")
      .addIntegerOption((opt) =>
        opt.setName("number").setDescription("Task number from /cron list").setRequired(true)
      )
  ),
```

**Step 2: Slash command handler 重構**

移除 `case "schedule":`, `case "schedules":`, `case "unschedule":` 三個 case，替換為：

```typescript
case "cron": {
  const sub = interaction.options.getSubcommand();
  if (sub === "add") {
    // 搬移原 case "schedule" 邏輯
  } else if (sub === "list") {
    // 搬移原 case "schedules" 邏輯
  } else if (sub === "del") {
    // 搬移原 case "unschedule" 邏輯
  }
  break;
}
```

**Step 3: 文字指令回退重構**

移除 3 個文字指令區塊（原 line ~2042-2152）：
- `if (textCmd === "/schedule" || ...)`
- `if (textCmd === "/schedules")`
- `if (textCmd.startsWith("/unschedule"))`

替換為：
```typescript
if (textCmd === "/cron" || textCmd.startsWith("/cron ")) {
  const args = cleanContent.slice("/cron".length).trim();
  const parts = args.split(/\s+/);
  const subCmd = parts[0]?.toLowerCase();

  if (subCmd === "add") {
    const input = args.slice("add".length).trim();
    // 搬移原 /schedule 文字指令邏輯
  } else if (subCmd === "list") {
    // 搬移原 /schedules 文字指令邏輯
  } else if (subCmd === "del") {
    const arg = parts[1];
    // 搬移原 /unschedule 文字指令邏輯
  } else {
    // 顯示用法說明
  }
  return;
}
```

**Step 4: callback query data 更新**

同 Task 2 的 Step 2，將 `schedule:confirm:` / `schedule:cancel:` 前綴改為 `cron:confirm:` / `cron:cancel:`。

**Step 5: Help 文字更新**

在 `getHelpText()` 函式中（原 line ~231-233），更新：
```
`/cron add [task]` -- 新增排程任務
`/cron list` -- 列出排程任務
`/cron del [number]` -- 移除排程任務
```

---

### Task 4: 驗證

**Step 1: 型別檢查**
```bash
npx tsc --noEmit
```
Expected: 零錯誤

**Step 2: 測試**
```bash
npm test
```
Expected: 60/61 通過

**Step 3: 殘留檢查**
```bash
grep -rn 'bot\.command("schedule"' src/
grep -rn 'setName("schedule")' src/
grep -rn 'setName("schedules")' src/
grep -rn 'setName("unschedule")' src/
```
Expected: 全部零匹配

**Step 4: 新指令確認**
```bash
grep -rn '"cron"' src/daemon.ts src/worker.ts src/discord-worker.ts
```
Expected: 有匹配

---

## Risk Register

| 風險 | 影響 | 機率 | 緩解 |
|------|------|------|------|
| Telegram 使用者不知道子命令 | UX 降級 | 中 | `/cron` 無參數時顯示完整說明 |
| 舊 callback data 殘留在已發送的 Telegram 訊息中 | 按鈕失效 | 低 | 舊 `schedule:` callback 已不匹配，按鈕回覆 "Confirmation expired" |
| Manager bot 的 `/schedules` 需要同步改名 | 不一致 | 低 | P1 處理，暫不影響功能 |

---

## Implementation Handoff

**修改檔案：**
1. `src/daemon.ts` — WORKER_COMMANDS（最小改動，先做）
2. `src/worker.ts` — Telegram 指令重構（中等改動）
3. `src/discord-worker.ts` — Discord 指令重構（最大改動）

**執行順序：** 1 → 2 → 3 → 驗證

**Review Checkpoint：** Task 2 完成後做一次型別檢查，確認 Telegram 端正確再進 Discord。
