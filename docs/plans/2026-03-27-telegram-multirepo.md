# Telegram Multi-Repo Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add BridgeRouter to Telegram workers to support multiple repo management with `/repo add/switch/remove/list` commands and display repo alias in message footers.

**Architecture:**
- Refactor Telegram worker initialization in daemon.ts to use `BridgeRouter` instead of single `ClaudeBridge`
- Update createWorker() signature to accept BridgeRouter (matching Discord pattern)
- Add repo management commands to worker.ts (copy from discord-worker.ts)
- Modify onResult callback to display repo alias in message footer
- Handle repo state persistence per-repo in `<repo>/.elsa/state.json`

**Tech Stack:**
- `BridgeRouter` — existing multi-bridge manager (already in codebase)
- `repo-manager.js` — repo persistence layer
- grammy — Telegram bot framework

---

## Task 1: Update daemon.ts Telegram Worker Initialization

**Files:**
- Modify: `src/daemon.ts:52-96`

**Step 1: Read daemon.ts startWorker function**

Current code at line 52-96 creates single `ClaudeBridge`. Need to change to `BridgeRouter` pattern (like Discord at line 122-150).

**Step 2: Write updated startWorker function**

```typescript
async function startWorker(botConfig: BotConfig): Promise<void> {
  const { createWorker } = await import("./worker.js");

  const botId = botConfig.id;
  const router = new BridgeRouter(botId, botConfig.username);
  const tunnelManager = new TunnelManager(config.NGROK_AUTH_TOKEN);

  // Load saved repos and add them to the router
  const savedRepos = loadRepos();
  for (const repoConfig of savedRepos) {
    router.addRepo(repoConfig);
  }

  // If no saved repos but botConfig has a workingDir, add it as a fallback
  if (savedRepos.length === 0 && botConfig.workingDir) {
    router.addRepo({
      path: botConfig.workingDir,
      alias: path.basename(botConfig.workingDir),
      addedAt: new Date().toISOString(),
    });
  }

  const bot = createWorker(botConfig, router, tunnelManager, scheduleManager);

  await bot.init();
  await bot.api.setMyCommands(WORKER_COMMANDS);

  addBot(botConfig);
  activeWorkers.set(botConfig.id, { config: botConfig, bot, router, tunnelManager });

  // Fire-and-forget: polling runs in background with 409 retry logic.
  const startPolling = async () => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 15_000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await bot.start();
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409") && attempt < MAX_RETRIES) {
          const wait = RETRY_DELAY_MS * attempt;
          console.log(`[${botConfig.username}] 409 Conflict (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
  };

  console.log(`Worker started: @${botConfig.username} (multi-repo mode)`);
  startPolling().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${botConfig.username}] Polling error:`, msg);
    router.abortAll();
    try { bot.stop(); } catch {}
    activeWorkers.delete(botConfig.id);
    lastWorkerError.set(botConfig.id, Date.now());
  });
}
```

**Step 3: Update activeWorkers type**

Change line 18 from:
```typescript
const activeWorkers = new Map<number, { config: BotConfig; bot: Bot; bridge: ClaudeBridge; tunnelManager: TunnelManager }>();
```

To:
```typescript
const activeWorkers = new Map<number, { config: BotConfig; bot: Bot; router: BridgeRouter; tunnelManager: TunnelManager }>();
```

**Step 4: Update stopWorker function**

Change line 102 from:
```typescript
worker.bridge.abortAll();
```

To:
```typescript
worker.router.abortAll();
```

**Step 5: Add BridgeRouter import**

Verify line 6 has:
```typescript
import { BridgeRouter } from "./bridge-router.js";
```

**Step 6: Commit changes**

```bash
git add src/daemon.ts
git commit -m "refactor: switch Telegram worker to BridgeRouter for multi-repo support"
```

---

## Task 2: Update createWorker() Signature

**Files:**
- Modify: `src/worker.ts:48`

**Step 1: Update function signature**

Change line 48 from:
```typescript
export function createWorker(botConfig: BotConfig, bridge: ClaudeBridge, tunnelManager: TunnelManager, scheduleManager: ScheduleManager): Bot {
```

To:
```typescript
export function createWorker(botConfig: BotConfig, router: BridgeRouter, tunnelManager: TunnelManager, scheduleManager: ScheduleManager): Bot {
```

**Step 2: Add BridgeRouter import**

Add to imports at top of worker.ts:
```typescript
import { BridgeRouter } from "./bridge-router.js";
```

Remove this line (no longer needed):
```typescript
import { ClaudeBridge, AVAILABLE_MODELS, AVAILABLE_PERMISSION_MODES } from "./claude.js";
```

Add this line instead:
```typescript
import { AVAILABLE_MODELS, AVAILABLE_PERMISSION_MODES } from "./claude.js";
```

**Step 3: Replace all `bridge.sendMessage()` calls with `router.sendMessage()`**

Find all occurrences (approximately line 760-850) and replace:
```typescript
bridge.sendMessage(chatId, prompt, {...})
```

With:
```typescript
router.sendMessage(chatId, prompt, {...})
```

**Step 4: Run type check**

```bash
npx tsc --noEmit
```

Expected: Should see compilation errors if not all `bridge` references are updated.

**Step 5: Commit changes**

```bash
git add src/worker.ts
git commit -m "refactor: update createWorker to accept BridgeRouter instead of ClaudeBridge"
```

---

## Task 3: Add Repo Management Commands to Telegram Worker

**Files:**
- Modify: `src/worker.ts` — add `/repo` command handlers
- Reference: `src/discord-worker.ts` — copy repo command implementations

**Step 1: Add repo imports**

Add to imports in worker.ts:
```typescript
import {
  addRepo as addRepoToDisk,
  removeRepo as removeRepoFromDisk,
  getRepoByAlias,
  loadRepos,
} from "./repo-manager.js";
import type { RepoConfig } from "./repo-manager.js";
```

**Step 2: Find command handler section**

Locate the command handling section around line 100-550 where `/new`, `/model`, `/cost` etc. are handled.

**Step 3: Add `/repo add` handler**

Add after existing command handlers:

```typescript
bot.command("repo", async (ctx) => {
  if (!isOwner(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return;
  }

  const args = ctx.match?.trim().split(/\s+/) || [];
  const subcommand = args[0];

  if (subcommand === "add") {
    const repoPath = args[1];
    const alias = args[2];

    if (!repoPath) {
      await ctx.reply(
        "Usage: `/repo add <path> [alias]`\n\n" +
        "Example: `/repo add /home/user/myproject` (auto-derives alias from dirname)\n" +
        "Or: `/repo add /home/user/myproject myproject-v2`"
      );
      return;
    }

    try {
      const newRepo = await addRepoToDisk(repoPath, alias);
      router.addRepo(newRepo);
      await ctx.reply(`✅ Repo added: **${newRepo.alias}** → \`${newRepo.path}\``);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Failed to add repo: ${msg}`);
    }
    return;
  }

  if (subcommand === "list") {
    const repos = router.listRepos();
    if (repos.length === 0) {
      await ctx.reply("No repos registered.");
      return;
    }

    let message = "<b>Registered repos:</b>\n\n";
    const current = router.getCurrentRepo(ctx.chatId);
    for (const repo of repos) {
      const marker = current?.alias === repo.alias ? "✅" : "  ";
      message += `${marker} <b>${repo.alias}</b>\n\`${repo.path}\`\n\n`;
    }
    await ctx.reply(message);
    return;
  }

  if (subcommand === "switch") {
    const alias = args[1];
    if (!alias) {
      await ctx.reply("Usage: `/repo switch <alias>`");
      return;
    }

    const repo = getRepoByAlias(alias);
    if (!repo) {
      await ctx.reply(`❌ Repo not found: ${alias}`);
      return;
    }

    router.switchRepo(ctx.chatId, alias);
    await ctx.reply(`✅ Switched to: **${alias}** → \`${repo.path}\``);
    return;
  }

  if (subcommand === "remove") {
    const alias = args[1];
    if (!alias) {
      await ctx.reply("Usage: `/repo remove <alias>`");
      return;
    }

    try {
      await removeRepoFromDisk(alias);
      router.removeRepo(alias);
      await ctx.reply(`✅ Repo removed: ${alias}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Failed to remove repo: ${msg}`);
    }
    return;
  }

  // No subcommand or invalid subcommand
  await ctx.reply(
    "<b>/repo</b> — Manage multiple project directories\n\n" +
    "<b>Subcommands:</b>\n" +
    "  <b>add</b> <path> [alias] — Register a new repo\n" +
    "  <b>list</b> — Show all repos\n" +
    "  <b>switch</b> <alias> — Change active repo\n" +
    "  <b>remove</b> <alias> — Unregister a repo"
  );
});
```

**Step 4: Add `/repo` to WORKER_COMMANDS in daemon.ts**

Add line to WORKER_COMMANDS array (around line 27-41):
```typescript
{ command: "repo",       description: "Manage project directories (add / list / switch / remove)" },
```

**Step 5: Create helper function to get current repo name**

Add near top of bot message handler (around line 50-100 in worker.ts):

```typescript
function getRepoName(chatId: number): string {
  const repo = router.getCurrentRepo(chatId);
  if (repo) return repo.alias;
  const repos = router.listRepos();
  return repos.length > 0 ? repos[0].alias : "no-repo";
}
```

**Step 6: Run type check**

```bash
npx tsc --noEmit
```

Expected: No errors

**Step 7: Commit changes**

```bash
git add src/worker.ts src/daemon.ts
git commit -m "feat: add /repo command for multi-repo management in Telegram"
```

---

## Task 4: Update onResult Callback to Show Repo Alias

**Files:**
- Modify: `src/worker.ts:830` (the footer line in onResult)

**Step 1: Find onResult callback**

Located around line 785-834.

**Step 2: Update footer message**

Change line 830 from:
```typescript
`${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s`
```

To:
```typescript
`${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s | 📂 ${getRepoName(chatId)}`
```

**Step 3: Verify getRepoName function exists**

Confirm you added it in Task 3, Step 5.

**Step 4: Run type check**

```bash
npx tsc --noEmit
```

Expected: No errors

**Step 5: Test locally**

```bash
npm run build
npm start
```

Send a message to Telegram bot and verify footer shows repo alias.

**Step 6: Commit changes**

```bash
git add src/worker.ts
git commit -m "feat: display repo alias in Telegram message footers"
```

---

## Task 5: Update Help Text

**Files:**
- Modify: `src/worker.ts` — `/help` command handler

**Step 1: Find help handler**

Search for `/help` command handler (approximately line 200-240).

**Step 2: Update help text to mention `/repo` command**

Ensure help includes:
```
/repo — Manage project directories
```

Current help mentions: `/new`, `/model`, `/cost`, `/session`, `/resume`, `/cancel`, `/help`, `/preview`, `/close`, `/cron`, `/allow`, `/deny`, `/members`

Add `/repo` to the list.

**Step 3: Commit changes**

```bash
git add src/worker.ts
git commit -m "docs: update /help to include /repo command"
```

---

## Testing Checklist

After completing all tasks:

- [ ] Type check passes: `npx tsc --noEmit`
- [ ] Build succeeds: `npm run build`
- [ ] Daemon starts: `npm start` (or `npm run dev`)
- [ ] Telegram bot `/repo list` shows default repo
- [ ] `/repo add /path/to/another-repo` successfully adds repo
- [ ] `/repo switch <alias>` changes active repo
- [ ] Message footer shows correct repo alias after switch
- [ ] `/repo remove <alias>` removes repo
- [ ] Multiple chats can have different active repos
- [ ] State persists in `<repo>/.elsa/state.json` for each repo

---

## Implementation Notes

- **Backward Compatibility:** Single-repo Telegram bots will work as-is (fallback to workingDir)
- **Parallel Session Support:** Each chatId can have different repo active (via BridgeRouter)
- **Repo State:** Per-repo session files stored in `<repo>/.elsa/state.json` (like Discord)
- **Comparison to Discord:** Telegram now has feature parity with Discord multi-repo support
