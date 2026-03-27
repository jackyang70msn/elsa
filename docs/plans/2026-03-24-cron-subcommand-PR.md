# PR: refactor: rename /schedule commands to /cron subcommands

## Summary

- 將 `/schedule`, `/schedules`, `/unschedule` 三個獨立指令重構為 `/cron add|list|del` 子命令
- 兩平台（Telegram + Discord）統一指令語法
- 遵循既有 `/repo add|list|switch|remove` 的 subcommand 模式
- callback query data 前綴從 `schedule:` 更名為 `cron:`

## Scope (P0)

- Discord: `SlashCommandBuilder` 改為 `addSubcommand()` 模式
- Discord: 文字指令回退改為 `/cron add|list|del`
- Telegram: 三個 `bot.command()` 合併為單一 `bot.command("cron")`
- `WORKER_COMMANDS` 從 3 行縮減為 1 行
- Help 文字更新

## Test plan

- [ ] `npx tsc --noEmit` 零錯誤
- [ ] `npm test` 60/61 通過
- [ ] `grep` 確認無殘留 `bot.command("schedule"` 或 `setName("schedule")`
- [ ] Discord: `/cron add every day 9am run tests` → 顯示確認
- [ ] Discord: `/cron list` → 列出排程
- [ ] Discord: `/cron del 1` → 移除排程
- [ ] Telegram: `/cron add every day 9am run tests` → 顯示確認
- [ ] Telegram: `/cron list` → 列出排程
- [ ] Telegram: `/cron del 1` → 移除排程
- [ ] Telegram: `/cron`（無參數） → 顯示用法說明

## Out of scope

- ScheduleManager 內部邏輯
- Schedule 資料結構（schedules.json 格式不變）
- Manager bot `/schedules` 指令（P1）
- scheduler.ts 核心邏輯
