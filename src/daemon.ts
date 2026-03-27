import fs from "node:fs";
import path from "node:path";
import type { Bot } from "grammy";
import type { Client } from "discord.js";
import { ClaudeBridge } from "./claude.js";
import { BridgeRouter } from "./bridge-router.js";
import { loadRepos } from "./repo-manager.js";
import { loadBots, addBot, removeBot, loadDiscordBots, addDiscordBot, removeDiscordBot, snowflakeToNumeric } from "./store.js";
import type { BotConfig, DiscordBotConfig } from "./store.js";
import { DATA_DIR, config } from "./config.js";
import { TunnelManager } from "./tunnel.js";
import { ScheduleManager, loadSchedules } from "./scheduler.js";
import type { SendCallbacks } from "./claude.js";

const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const HEALTH_CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes — grammY handles transient reconnects internally

const activeWorkers = new Map<number, { config: BotConfig; bot: Bot; router: BridgeRouter; tunnelManager: TunnelManager }>();
const activeDiscordWorkers = new Map<string, { config: DiscordBotConfig; client: Client; router: BridgeRouter; tunnelManager: TunnelManager }>();
let scheduleManager: ScheduleManager;
const lastWorkerError = new Map<number, number>(); // botId → timestamp of last polling error
const lastDiscordWorkerError = new Map<string, number>();
const RESTART_COOLDOWN_MS = 120_000; // wait 2 minutes before restarting a failed worker
let healthCheckTimer: NodeJS.Timeout | null = null;
let discordManagerClient: Client | null = null;

const WORKER_COMMANDS = [
  { command: "new",        description: "Start a fresh session" },
  { command: "model",      description: "Switch Claude model (Opus / Sonnet / Haiku)" },
  { command: "cost",       description: "Show token usage for this session" },
  { command: "session",    description: "Get session ID to resume in CLI" },
  { command: "resume",     description: "Resume a CLI session in Telegram" },
  { command: "cancel",     description: "Abort the current operation" },
  { command: "help",       description: "Show help" },
  { command: "preview",    description: "Open live preview tunnel to your dev server" },
  { command: "close",      description: "Close active preview tunnel" },
  { command: "repo",       description: "Manage project directories (add / list / switch / remove)" },
  { command: "cron",       description: "Manage scheduled tasks (add / list / del)" },
  { command: "allow",      description: "Authorize a user in this chat (owner only)" },
  { command: "deny",       description: "Remove user authorization (owner only)" },
  { command: "members",    description: "List authorized users (owner only)" },
];

const MANAGER_COMMANDS = [
  { command: "bots",         description: "List active worker bots" },
  { command: "add",          description: "Add a new worker bot" },
  { command: "remove",       description: "Remove a worker bot (or 'all')" },
  { command: "schedules",    description: "View all scheduled tasks across bots" },
  { command: "cancel",       description: "Cancel current operation" },
  { command: "help",         description: "Show help" },
];

async function startWorker(botConfig: BotConfig): Promise<void> {
  const { createWorker } = await import("./worker.js");

  const router = new BridgeRouter(botConfig.id, botConfig.username);
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
  // When a previous instance's getUpdates long-poll is still alive (up to 30s timeout),
  // Telegram returns 409 Conflict. We retry with backoff, waiting long enough for it to expire.
  const startPolling = async () => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 15_000; // 15s × 1, 15s × 2 = 45s total window (> 30s poll timeout)
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

  const repoCount = router.listRepos().length;
  console.log(`Worker started: @${botConfig.username} (${repoCount} repos)`);
  startPolling().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${botConfig.username}] Polling error:`, msg);
    router.abortAll();
    router.shutdown();
    try { bot.stop(); } catch {}
    activeWorkers.delete(botConfig.id);
    lastWorkerError.set(botConfig.id, Date.now());
  });
}

async function stopWorker(botId: number): Promise<void> {
  const worker = activeWorkers.get(botId);
  if (!worker) return;

  worker.router.abortAll();
  worker.router.shutdown();
  scheduleManager.removeAllForBot(botId);
  await worker.tunnelManager.closeAll();
  await worker.bot.stop();
  activeWorkers.delete(botId);
  removeBot(botId);

  console.log(`Worker stopped: @${worker.config.username}`);
}

function getActiveWorkers(): Map<number, { config: BotConfig }> {
  const result = new Map<number, { config: BotConfig }>();
  for (const [id, w] of activeWorkers) {
    result.set(id, { config: w.config });
  }
  return result;
}

// --- Discord worker lifecycle ---

async function startDiscordWorker(botConfig: DiscordBotConfig): Promise<void> {
  // Lazy import to avoid loading discord.js when Discord is not configured
  const { createDiscordWorker } = await import("./discord-worker.js");

  const numericId = snowflakeToNumeric(botConfig.id);
  const router = new BridgeRouter(numericId, botConfig.username);
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

  const client = createDiscordWorker(botConfig, router, tunnelManager, scheduleManager);

  addDiscordBot(botConfig);
  activeDiscordWorkers.set(botConfig.id, { config: botConfig, client, router, tunnelManager });

  await client.login(botConfig.token);
  const repoCount = router.listRepos().length;
  console.log(`Discord worker started: ${botConfig.username} (${repoCount} repos)`);
}

async function stopDiscordWorker(botId: string): Promise<void> {
  const worker = activeDiscordWorkers.get(botId);
  if (!worker) return;

  worker.router.abortAll();
  worker.router.shutdown();
  scheduleManager.removeAllForBot(snowflakeToNumeric(botId));
  await worker.tunnelManager.closeAll();
  worker.client.destroy();
  activeDiscordWorkers.delete(botId);
  removeDiscordBot(botId);

  console.log(`Discord worker stopped: ${worker.config.username}`);
}

function getActiveDiscordWorkers(): Map<string, { config: DiscordBotConfig }> {
  const result = new Map<string, { config: DiscordBotConfig }>();
  for (const [id, w] of activeDiscordWorkers) {
    result.set(id, { config: w.config });
  }
  return result;
}

function isProcessRunning(pid: number): boolean {
  try {
    // Use signal 0 (non-destructive check) to see if process exists
    // On Windows & Unix: throws if process doesn't exist
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Check if another daemon instance is already running
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  // Clean up stale PID file (process exited but file wasn't deleted)
  if (fs.existsSync(PID_FILE)) {
    try {
      const pidStr = fs.readFileSync(PID_FILE, "utf-8").trim();
      const existingPid = Number(pidStr);

      if (existingPid && !isNaN(existingPid) && existingPid !== process.pid) {
        if (isProcessRunning(existingPid)) {
          // Another daemon is truly running
          process.stderr.write(`❌ Daemon already running with PID ${existingPid}\n`);
          process.stderr.write(`   Stop it first: npx tsx src/cli.ts stop\n`);
          process.exit(1);
        }
      }
      // Remove stale PID file (whether it's our current PID or a dead process)
      fs.rmSync(PID_FILE, { force: true });
    } catch {
      // If PID file is corrupted, we'll create a new one below
    }
  }

  // Write our own PID so the CLI can detect us even if launched via npm start
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Shared no-op callbacks for scheduled tasks (no human interaction)
  const scheduledCallbacks: Pick<SendCallbacks,
    "onStreamChunk" | "onStatusUpdate" | "onToolApproval" |
    "onAskUser" | "onPlanApproval" | "onSessionReset"
  > = {
    onStreamChunk: () => {},
    onStatusUpdate: () => {},
    onToolApproval: async () => "allow",
    onAskUser: async () => ({}),
    onPlanApproval: async () => true,
    onSessionReset: () => {},
  };

  // Initialize schedule manager
  scheduleManager = new ScheduleManager(async (schedule) => {
    const { botId, chatId, prompt, id: scheduleId, platform, channelId } = schedule;

    if (platform === "discord" && channelId) {
      // Discord path: find discord worker by numeric botId
      let discordWorker: { config: DiscordBotConfig; client: Client; router: BridgeRouter; tunnelManager: TunnelManager } | undefined;
      for (const [id, w] of activeDiscordWorkers) {
        if (snowflakeToNumeric(id) === botId) {
          discordWorker = w;
          break;
        }
      }
      if (!discordWorker) {
        console.error(`[scheduler] Discord worker ${botId} not found for schedule ${scheduleId}`);
        return;
      }

      const channel = await discordWorker.client.channels.fetch(channelId).catch((err: Error) => {
        console.error(`[scheduler] Failed to fetch channel ${channelId}: ${err.message}`);
        return null;
      });
      if (!channel || !("send" in channel)) {
        console.error(`[scheduler] Discord channel ${channelId} not sendable (type=${channel?.type}) for schedule ${scheduleId}`);
        return;
      }

      discordWorker.router.clearSession(chatId);
      await discordWorker.router.sendMessage(chatId, prompt, {
        ...scheduledCallbacks,
        onResult: async (result) => {
          const text = result.text || "Task completed.";
          const { claudeToDiscord, splitDiscordMessage } = await import("./discord-formatter.js");
          const formatted = claudeToDiscord(text);
          const parts = splitDiscordMessage(formatted);
          for (const part of parts) {
            await channel.send(`**Scheduled task done**\n\n${part}`).catch(() => {});
          }
        },
        onError: async (err) => {
          await channel.send(`Scheduled task failed: ${err.message}`).catch(() => {});
        },
      }, "bypassPermissions", 25);
    } else {
      // Telegram path (default, backwards compatible)
      const worker = activeWorkers.get(botId);
      if (!worker) {
        console.error(`[scheduler] Worker ${botId} not found for schedule ${scheduleId}`);
        return;
      }
      worker.router.clearSession(chatId);
      await worker.router.sendMessage(chatId, prompt, {
        ...scheduledCallbacks,
        onResult: async (result) => {
          const text = result.text || "Task completed.";
          const { claudeToTelegram, splitMessage } = await import("./formatter.js");
          const html = claudeToTelegram(text);
          const parts = splitMessage(html);
          for (const part of parts) {
            try {
              await worker.bot.api.sendMessage(chatId, `<b>Scheduled task done</b>\n\n${part}`, { parse_mode: "HTML" });
            } catch {
              await worker.bot.api.sendMessage(chatId, part).catch(() => {});
            }
          }
        },
        onError: async (err) => {
          await worker.bot.api.sendMessage(chatId, `Scheduled task failed: ${err.message}`).catch(() => {});
        },
      }, "bypassPermissions", 25);
    }
  });

  let managerBot: Bot | null = null;

  // --- Telegram integration (optional) ---
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_OWNER_IDS.length > 0) {
    const { createManager } = await import("./manager.js");
    managerBot = createManager({ startWorker, stopWorker, getActiveWorkers });

    // Exit immediately if another instance is already polling this token
    managerBot.catch((err) => {
      if (err.message.includes("409: Conflict")) {
        console.error("Another daemon is already running. Stop it first: elsa stop");
      } else {
        console.error("[manager] Error:", err.message);
      }
      shutdown();
    });

    await managerBot.api.setMyCommands(MANAGER_COMMANDS);

    // Restore saved workers in parallel
    const savedBots = loadBots();
    await Promise.allSettled(savedBots.map(botConfig =>
      startWorker(botConfig).catch(err =>
        console.error(`Failed to restore worker @${botConfig.username}:`, err)
      )
    ));
  } else {
    console.log("Telegram not configured, skipping...");
  }

  // --- Discord integration (optional) ---
  if (config.DISCORD_BOT_TOKEN && config.DISCORD_OWNER_IDS.length > 0) {
    try {
      const { createDiscordManager } = await import("./discord-manager.js");
      const savedDiscordBots = loadDiscordBots();
      const guildId = config.DISCORD_GUILD_ID || savedDiscordBots[0]?.guildId || "";
      discordManagerClient = createDiscordManager(
        config.DISCORD_BOT_TOKEN,
        guildId,
        { startWorker: startDiscordWorker, stopWorker: stopDiscordWorker, getActiveWorkers: getActiveDiscordWorkers }
      );
      await discordManagerClient.login(config.DISCORD_BOT_TOKEN);
      console.log(`Discord manager: ${discordManagerClient.user?.tag || "ready"}`);

      // Restore saved Discord workers in parallel
      if (savedDiscordBots.length > 0) {
        await Promise.allSettled(savedDiscordBots.map(bot =>
          startDiscordWorker(bot).catch(err =>
            console.error(`Failed to restore Discord worker ${bot.username}:`, err)
          )
        ));
      }

      console.log(`Active Discord workers: ${activeDiscordWorkers.size}`);
    } catch (err) {
      console.error("[discord] Failed to initialize Discord:", (err as Error).message);
    }
  }

  // Restore scheduled tasks
  scheduleManager.start(loadSchedules());

  // Periodic health check: restart dead workers and recover saved bots
  healthCheckTimer = setInterval(async () => {
    // 1. Check running workers in parallel
    const checks = [...activeWorkers.entries()].map(async ([id, worker]) => {
      try {
        await worker.bot.api.getMe();
      } catch (err) {
        console.error(`[${worker.config.username}] Health check failed, will restart: ${(err as Error).message}`);
        worker.router.abortAll();
        worker.router.shutdown();
        try { await worker.bot.stop(); } catch {}
        activeWorkers.delete(id);
        return worker.config;
      }
      return null;
    });
    const results = await Promise.allSettled(checks);
    const deadConfigs = results
      .filter((r): r is PromiseFulfilledResult<BotConfig> => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value);

    // 2. Restart dead workers in parallel
    if (deadConfigs.length > 0) {
      await Promise.allSettled(deadConfigs.map(async (cfg) => {
        try {
          await startWorker(cfg);
          console.log(`[${cfg.username}] Restarted after health check failure`);
        } catch (err) {
          console.error(`[${cfg.username}] Restart failed: ${(err as Error).message}`);
        }
      }));
    }

    // 3. Start any saved bots that aren't currently running
    const savedBots = loadBots();
    const missing = savedBots.filter(b => {
      if (activeWorkers.has(b.id)) return false;
      const lastError = lastWorkerError.get(b.id);
      return !lastError || Date.now() - lastError >= RESTART_COOLDOWN_MS;
    });
    if (missing.length > 0) {
      await Promise.allSettled(missing.map(async (botConfig) => {
        try {
          await startWorker(botConfig);
          lastWorkerError.delete(botConfig.id);
          console.log(`[${botConfig.username}] Recovered from saved config`);
        } catch (err) {
          console.error(`[${botConfig.username}] Recovery failed: ${(err as Error).message}`);
          lastWorkerError.set(botConfig.id, Date.now());
        }
      }));
    }

    // 4. Check Discord workers (WebSocket-based — check if client is ready)
    if (activeDiscordWorkers.size > 0) {
      const deadDiscord: DiscordBotConfig[] = [];
      for (const [id, worker] of activeDiscordWorkers) {
        if (!worker.client.isReady()) {
          console.error(`[${worker.config.username}] Discord health check failed, will restart`);
          worker.router.abortAll();
          worker.router.shutdown();
          try { worker.client.destroy(); } catch {}
          activeDiscordWorkers.delete(id);
          deadDiscord.push(worker.config);
        }
      }
      if (deadDiscord.length > 0) {
        await Promise.allSettled(deadDiscord.map(async (cfg) => {
          try {
            await startDiscordWorker(cfg);
            console.log(`[${cfg.username}] Discord worker restarted`);
          } catch (err) {
            console.error(`[${cfg.username}] Discord restart failed: ${(err as Error).message}`);
          }
        }));
      }

      // 5. Recover missing Discord bots from saved config
      const savedDiscordBots = loadDiscordBots();
      const missingDiscord = savedDiscordBots.filter(b => {
        if (activeDiscordWorkers.has(b.id)) return false;
        const lastError = lastDiscordWorkerError.get(b.id);
        return !lastError || Date.now() - lastError >= RESTART_COOLDOWN_MS;
      });
      if (missingDiscord.length > 0) {
        await Promise.allSettled(missingDiscord.map(async (bot) => {
          try {
            await startDiscordWorker(bot);
            lastDiscordWorkerError.delete(bot.id);
            console.log(`[${bot.username}] Discord worker recovered`);
          } catch (err) {
            console.error(`[${bot.username}] Discord recovery failed: ${(err as Error).message}`);
            lastDiscordWorkerError.set(bot.id, Date.now());
          }
        }));
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Start manager bot polling with 409 retry logic (Telegram only).
  if (managerBot) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 15_000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await managerBot.start({
          onStart: (info) => {
            console.log(`Manager bot: @${info.username}`);
            console.log(`Active workers: ${activeWorkers.size}`);
            console.log(`\nReady! DM @${info.username} to manage bots`);
          },
        });
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409") && attempt < MAX_RETRIES) {
          const wait = RETRY_DELAY_MS * attempt;
          console.log(`[manager] 409 Conflict (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
  } else if (!discordManagerClient) {
    console.error("No platform configured. Set TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN.");
    process.exit(1);
  } else {
    // Discord-only mode: keep process alive
    console.log("\nReady! Discord-only mode.");
    await new Promise(() => {}); // block forever until shutdown signal
  }
}

const shutdown = async () => {
  console.log("\nShutting down...");
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  scheduleManager?.stop();
  for (const [, worker] of activeWorkers) {
    worker.router.abortAll();
    worker.router.shutdown();
    try { await worker.tunnelManager.closeAll(); } catch {}
    try { await worker.bot.stop(); } catch {}
  }
  activeWorkers.clear();
  for (const [, worker] of activeDiscordWorkers) {
    worker.router.abortAll();
    worker.router.shutdown();
    try { await worker.tunnelManager.closeAll(); } catch {}
    try { worker.client.destroy(); } catch {}
  }
  activeDiscordWorkers.clear();
  if (discordManagerClient) {
    try { discordManagerClient.destroy(); } catch {}
  }
  fs.rmSync(PID_FILE, { force: true });
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await shutdown();
});
