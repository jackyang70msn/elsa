# 多 Discord Manager Bot 實作計畫

## 目標

支援多個 Discord Manager bot，每個管理不同 Guild 的 worker bots，並提供 CLI 指令方便新增/移除 manager。

## 改動總覽

| 檔案 | 改動幅度 | 說明 |
|------|---------|------|
| `src/store.ts` | 小 | 新增 `DiscordManagerConfig` 介面 + CRUD，`DiscordBotConfig` 加 `managerId?` |
| `src/discord-manager.ts` | 小 | `createDiscordManager` 加 `ownerIds` 參數，取代全域 `isDiscordOwner` |
| `src/daemon.ts` | 中 | 單一 manager → `Map<id, Client>` 迴圈啟動，健康檢查、shutdown 都要改 |
| `src/cli.ts` | 中 | 新增 `elsa discord add-manager/remove-manager/list-managers` 子指令 |
| `src/config.ts` | 微 | 幾乎不動，保留舊設定作為向後相容 fallback |

## 核心設計

### 1. 新增儲存結構 — `~/.elsa/discord-managers.json`

```typescript
interface DiscordManagerConfig {
  id: string;          // Bot user ID（唯一鍵）
  token: string;
  username: string;
  guildId: string;
  ownerIds: string[];
  addedAt: string;     // ISO timestamp
}
```

CRUD 函式（放在 `src/store.ts`）：

- `loadDiscordManagers(): DiscordManagerConfig[]`
- `saveDiscordManagers(managers: DiscordManagerConfig[]): void`
- `addDiscordManager(manager: DiscordManagerConfig): void`
- `removeDiscordManager(managerId: string): void`

### 2. Worker 歸屬

`DiscordBotConfig` 新增可選欄位：

```typescript
interface DiscordBotConfig {
  id: string;
  token: string;
  username: string;
  guildId: string;
  workingDir: string;
  managerId?: string;  // 新增：parent manager 的 bot ID
}
```

- `/add` 建立 worker 時自動記錄 `managerId`
- 每個 manager 的 `getActiveWorkers` 只回傳自己的 workers（以 `managerId` 過濾）
- 沒有 `managerId` 的舊 worker 紀錄，啟動時分配給匹配 `guildId` 的 manager

### 3. Discord Manager 改動

`createDiscordManager` 新增 `ownerIds: string[]` 參數，auth check 從全域改為 per-instance：

```typescript
// 舊
if (!isDiscordOwner(interaction.user.id))

// 新
if (!ownerIds.includes(interaction.user.id))
```

每個 manager 實例閉包中持有自己的 `guildId`，已天然支援多實例。

### 4. Daemon 啟動邏輯

將 `discordManagerClient: Client | null` 改為 Map：

```typescript
const activeDiscordManagers = new Map<string, { config: DiscordManagerConfig; client: Client }>();
```

啟動流程：

1. 載入 `discord-managers.json`
2. 若為空但有舊 `config.json` 中的 `DISCORD_BOT_TOKEN`，自動遷移為一筆 manager config
3. 對每筆 manager config：
   - `createDiscordManager(token, guildId, ownerIds, callbacks)`
   - `await client.login(token)`
   - 存入 `activeDiscordManagers`
4. 載入 `discord-bots.json`，每個 worker 根據 `managerId` 或 `guildId` 找到對應 manager 啟動

健康檢查：新增對 `activeDiscordManagers` 的 `isReady()` 檢查，死掉的 manager 自動重連。

Shutdown：遍歷 `activeDiscordManagers` 逐一 `destroy()`。

### 5. CLI 指令

```bash
elsa discord add-manager      # 互動式：輸入 token → 驗證 → 輸入 guildId + ownerIds → 儲存
elsa discord remove-manager   # 列出 managers → 選擇移除
elsa discord list-managers    # 顯示所有 manager 的資訊
```

`add-manager` 流程：

1. 詢問 bot token
2. 用 Discord API 驗證 token，取得 bot ID 和 username
3. 詢問 guild ID
4. 詢問 owner ID(s)（逗號分隔）
5. 寫入 `discord-managers.json`
6. 提示重啟 daemon 生效

`remove-manager` 流程：

1. 讀取並列出所有 managers
2. 詢問要移除的 manager（by username 或 ID）
3. 從 `discord-managers.json` 移除
4. 提示重啟 daemon 生效

### 6. 自動遷移（向後相容）

daemon 啟動時：

- 若 `discord-managers.json` 不存在或為空
- 但 `config.json` 中有 `DISCORD_BOT_TOKEN` + `DISCORD_GUILD_ID` + `DISCORD_OWNER_ID`
- 則自動建立一筆 manager config（login 取得 bot ID 和 username）
- 寫入 `discord-managers.json`，後續統一由新機制管理

## 注意事項

- **Slash command 不衝突**：Discord 每個 bot 有獨立的 command namespace，多個 manager 在不同 guild 不會衝突
- **孤兒 worker**：manager 被移除後，其 worker 仍可繼續運行，下次健康檢查時正常管理
- **`discord-bots.json` 共享**：所有 Discord workers 仍存在同一個檔案，用 `managerId` 欄位區分歸屬

## 實作順序

1. `src/store.ts` — 新增 `DiscordManagerConfig` 介面與 CRUD，`DiscordBotConfig` 加 `managerId?`
2. `src/discord-manager.ts` — `createDiscordManager` 加 `ownerIds` 參數
3. `src/daemon.ts` — 重構 Discord 啟動為多 manager 迴圈、健康檢查、shutdown
4. `src/cli.ts` — 新增 `elsa discord add-manager/remove-manager/list-managers`
5. 測試 — 驗證向後相容遷移 + 多 manager 啟動 + CLI 指令
