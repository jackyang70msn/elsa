import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { config, DATA_DIR, isOwner } from "./config.js";
import { AVAILABLE_MODELS, AVAILABLE_PERMISSION_MODES } from "./claude.js";
import { BridgeRouter } from "./bridge-router.js";
import type { BotConfig } from "./store.js";
import { TunnelManager, parsePort } from "./tunnel.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
  escapeHtml,
} from "./formatter.js";
import type { AskUserQuestion } from "./claude.js";
import { logUser, logStream, logResult, logError } from "./log.js";
import { ScheduleManager, parseScheduleWithClaude, generateScheduleId } from "./scheduler.js";
import type { Schedule } from "./scheduler.js";
import {
  addRepo as addRepoToDisk,
  removeRepo as removeRepoFromDisk,
  getRepoByAlias,
  loadRepos,
} from "./repo-manager.js";
import type { RepoConfig } from "./repo-manager.js";

const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const TYPING_INTERVAL_MS = 4000;
const EDIT_DEBOUNCE_MS = 800;
const APPROVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours — users interact async on mobile
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadTelegramFile(token: string, filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
  }
  return buffer;
}
const REPLY_PREVIEW_MAX = 500;
const STREAM_MAX_LEN = 4000;

const NGROK_SETUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to paste ngrok token

export function createWorker(botConfig: BotConfig, router: BridgeRouter, tunnelManager: TunnelManager, scheduleManager: ScheduleManager): Bot {
  const bot = new Bot(botConfig.token);
  const tag = botConfig.username;

  const pendingApprovals = new Map<
    string,
    { resolve: (result: "allow" | "always" | "deny") => void; timer: NodeJS.Timeout; description: string }
  >();
  const pendingPlanActions = new Map<
    string,
    { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
  >();
  const pendingAnswers = new Map<
    string,
    { resolve: (answer: string) => void; timer: NodeJS.Timeout; options: Array<{ label: string }>; question: string }
  >();
  const pendingFreeText = new Map<
    number,
    { resolve: (answer: string) => void; timer: NodeJS.Timeout; question: string; msgId: number }
  >();
  const pendingNgrokSetup = new Map<number, { port: number; timer: NodeJS.Timeout }>();
  const pendingScheduleConfirm = new Map<number, { schedule: Omit<Schedule, "id" | "createdAt" | "lastRunAt">; timer: NodeJS.Timeout }>();
  let approvalCounter = 0;
  let retryCounter = 0;

  function saveNgrokToken(token: string): void {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[${tag}] Failed to parse config file, not saving ngrok token:`, error);
        return;
      }
    }
    existing.NGROK_AUTH_TOKEN = token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  bot.catch((err) => {
    console.error(`[${tag}] Bot error:`, err.message);
  });

  // Owner or allowed user guard
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (isOwner(userId) || (chatId && userId && router.isAllowedUser(chatId, userId))) {
      await next();
      return;
    }
    await ctx.reply("Unauthorized.");
  });

  const repoName = path.basename(botConfig.workingDir);

  function getRepoName(chatId: number): string {
    const repo = router.getCurrentRepo(chatId);
    if (repo) return repo.alias;
    const repos = router.listRepos();
    return repos.length > 0 ? repos[0].alias : "no-repo";
  }

  const helpText =
    `<b>${escapeHtml(repoName)}</b>\n` +
    `<code>${escapeHtml(botConfig.workingDir)}</code>\n\n` +
    "Send any text or photo to interact with Claude Code.\n\n" +
    "<b>Commands:</b>\n" +
    "/new — Start a fresh session (clears context)\n" +
    "/model — Switch Claude model (Opus / Sonnet / Haiku)\n" +
    "/cost — Show token usage for the current session\n" +
    "/session — Get session ID to continue in CLI\n" +
    "/resume — Resume a CLI session in Telegram\n" +
    "/cancel — Abort the current operation\n" +
    "/repo — Manage project directories (add / list / switch / remove)\n" +
    "/allow — Authorize a user in this chat (owner only)\n" +
    "/deny — Remove a user from this chat (owner only)\n" +
    "/members — List authorized users (owner only)\n" +
    "/help — Show this help message\n\n" +
    "<b>Live Preview:</b>\n" +
    "/preview [port] — Start dev server and open live preview\n" +
    "/close — Close active preview tunnel\n\n" +
    "<b>Features:</b>\n" +
    "• Send documents (PDF, code files, etc.) for analysis\n" +
    "• Reply to any Claude message to include it as context\n" +
    "• Tap Retry on errors to re-run the last prompt\n\n" +
    "<b>Tips:</b>\n" +
    "• Send a photo with a caption to ask about images\n" +
    "• Claude can read, edit, and create files in your project\n" +
    "• Some tools require your approval via Approve/Deny buttons\n" +
    "• Use /cancel if a response is taking too long";

  bot.command("start", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  bot.command("allow", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("Only the owner can manage permissions.");
      return;
    }
    const replyMsg = ctx.message?.reply_to_message;
    const arg = ctx.match?.trim();
    let targetId: number | undefined;
    let targetName: string | undefined;
    if (replyMsg?.from && !replyMsg.from.is_bot) {
      targetId = replyMsg.from.id;
      targetName = replyMsg.from.first_name;
    } else if (arg) {
      const parsed = parseInt(arg, 10);
      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply("Invalid user ID. Usage: reply to a message with /allow, or /allow USER_ID");
        return;
      }
      targetId = parsed;
    }
    if (!targetId) {
      await ctx.reply("Reply to a user's message with /allow, or use /allow USER_ID");
      return;
    }
    if (isOwner(targetId)) {
      await ctx.reply("Owner is already authorized everywhere.");
      return;
    }
    router.allowUser(ctx.chat.id, targetId);
    const name = targetName ? ` (${escapeHtml(targetName)})` : "";
    await ctx.reply(`Authorized user ${targetId}${name} in this chat.`, { parse_mode: "HTML" });
  });

  bot.command("deny", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("Only the owner can manage permissions.");
      return;
    }
    const replyMsg = ctx.message?.reply_to_message;
    const arg = ctx.match?.trim();
    let targetId: number | undefined;
    if (replyMsg?.from && !replyMsg.from.is_bot) {
      targetId = replyMsg.from.id;
    } else if (arg) {
      const parsed = parseInt(arg, 10);
      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply("Invalid user ID. Usage: reply to a message with /deny, or /deny USER_ID");
        return;
      }
      targetId = parsed;
    }
    if (!targetId) {
      await ctx.reply("Reply to a user's message with /deny, or use /deny USER_ID");
      return;
    }
    if (router.denyUser(ctx.chat.id, targetId)) {
      await ctx.reply(`Removed user ${targetId} from this chat.`);
    } else {
      await ctx.reply(`User ${targetId} was not in the allowed list.`);
    }
  });

  bot.command("members", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("Only the owner can view permissions.");
      return;
    }
    const allowed = router.getAllowedUsers(ctx.chat.id);
    const ownerList = config.TELEGRAM_OWNER_IDS.map((id) => `  • ${id} (owner)`).join("\n");
    if (allowed.length === 0) {
      await ctx.reply(`<b>Authorized users:</b>\n${ownerList}\n\nNo additional users allowed in this chat.`, { parse_mode: "HTML" });
    } else {
      const userList = allowed.map((id) => `  • ${id}`).join("\n");
      await ctx.reply(`<b>Authorized users:</b>\n${ownerList}\n\n<b>Chat-specific:</b>\n${userList}`, { parse_mode: "HTML" });
    }
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    if (router.isProcessing(chatId)) {
      router.cancelQuery(chatId);
    }
    router.clearSession(chatId);
    await ctx.reply("Session cleared. Send a message to start fresh.");
  });

  bot.command("cost", async (ctx) => {
    const t = router.getSessionTokens(ctx.chat.id);
    const total = t.inputTokens + t.outputTokens;
    await ctx.reply(
      `<b>Session tokens</b>\n` +
        `Input: ${t.inputTokens.toLocaleString()}\n` +
        `Output: ${t.outputTokens.toLocaleString()}\n` +
        `Cache write: ${t.cacheCreationTokens.toLocaleString()}\n` +
        `Cache read: ${t.cacheReadTokens.toLocaleString()}\n` +
        `Total: ${total.toLocaleString()}`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("model", async (ctx) => {
    const current = router.getModel(ctx.chat.id);
    const currentLabel =
      AVAILABLE_MODELS.find((m) => m.id === current)?.label || current;

    const keyboard = new InlineKeyboard();
    for (const m of AVAILABLE_MODELS) {
      const check = m.id === current ? " (current)" : "";
      keyboard.text(`${m.label}${check}`, `model:${m.id}`).row();
    }

    await ctx.reply(`Current model: <b>${currentLabel}</b>\n\nSelect a model:`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  bot.command("mode", async (ctx) => {
    const current = router.getPermissionMode(ctx.chat.id);
    const currentLabel =
      AVAILABLE_PERMISSION_MODES.find((m) => m.id === current)?.label || current;

    const keyboard = new InlineKeyboard();
    for (const m of AVAILABLE_PERMISSION_MODES) {
      const check = m.id === current ? " ✓" : "";
      keyboard.text(`${m.label}${check}`, `mode:${m.id}`).row();
    }

    await ctx.reply(`Current mode: <b>${currentLabel}</b>\n\nSelect a permission mode:`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  bot.command("cancel", async (ctx) => {
    if (router.cancelQuery(ctx.chat.id)) {
      await ctx.reply("Operation cancelled.");
    } else {
      await ctx.reply("Nothing running to cancel.");
    }
  });

  bot.command("session", async (ctx) => {
    const sessionId = router.getSessionId(ctx.chat.id);
    if (!sessionId) {
      await ctx.reply("No active session. Send a message first to start one.");
      return;
    }
    const cmd = `claude --resume ${sessionId}`;
    await ctx.reply(
      `<b>Session ID</b>\n<code>${sessionId}</code>\n\n` +
        `<b>Continue in CLI</b>\n` +
        `Run this from <code>${botConfig.workingDir}</code>:\n\n` +
        `<code>${cmd}</code>\n\n` +
        `Tap the command above to copy it.`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("resume", async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.match?.toString().trim();

    if (args) {
      // Direct resume: /resume <session_id>
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(args)) {
        await ctx.reply("Invalid session ID format. Expected a UUID like: abc12345-1234-1234-1234-123456789abc");
        return;
      }

      const sessionFile = path.join(router.getProjectSessionsDir(chatId), `${args}.jsonl`);
      if (!fs.existsSync(sessionFile)) {
        await ctx.reply("Session file not found. Make sure this session was created in the current project directory.");
        return;
      }

      if (router.isProcessing(chatId)) {
        router.cancelQuery(chatId);
      }

      router.setSessionId(chatId, args);
      await sendSessionHistory(chatId, args);
      await ctx.reply(
        `✓ Session resumed: <code>${args}</code>\n\n` +
        `<i>Note: If the next message fails with "No conversation found", ` +
        `try /new to start fresh.</i>\n\nSend a message to continue.`,
        { parse_mode: "HTML" }
      );
    } else {
      // List recent sessions
      const sessions = router.listRecentSessions(8);
      if (sessions.length === 0) {
        await ctx.reply("No CLI sessions found for this project directory.");
        return;
      }

      const keyboard = new InlineKeyboard();
      for (const s of sessions) {
        const dateStr = s.modifiedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
          ", " + s.modifiedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        const label = `${dateStr} — ${s.promptPreview}`;
        const truncatedLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
        keyboard.text(truncatedLabel, `resume:${s.sessionId}`).row();
      }

      await ctx.reply("Select a session to resume:", { reply_markup: keyboard });
    }
  });

  // --- Repo management commands ---

  bot.command("repo", async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.match?.trim() || "";
    const spaceIdx = args.indexOf(" ");
    const subCmd = spaceIdx === -1 ? args.toLowerCase() : args.slice(0, spaceIdx).toLowerCase();
    const subArg = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

    if (subCmd === "add") {
      if (!subArg) {
        await ctx.reply(
          "<b>Add a Repository</b>\n\n" +
            "<code>/repo add /path/to/repo [alias]</code>\n\n" +
            "<b>Examples:</b>\n" +
            "<code>/repo add /home/user/myproject</code>\n" +
            "<code>/repo add /home/user/another my-app</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const parts = subArg.trim().split(/\s+/);
      const repoPath = parts[0];
      const alias = parts[1];

      try {
        const newRepo = addRepoToDisk(repoPath, alias);
        router.addRepo(newRepo);
        await ctx.reply(
          `<b>Repository Added</b>\n\n` +
            `<b>Alias:</b> <code>${escapeHtml(newRepo.alias)}</code>\n` +
            `<b>Path:</b> <code>${escapeHtml(newRepo.path)}</code>\n\n` +
            `Use <code>/repo switch ${escapeHtml(newRepo.alias)}</code> to switch to this repo.`,
          { parse_mode: "HTML" }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`<b>Error adding repository</b>\n\n${escapeHtml(msg)}`, { parse_mode: "HTML" });
      }
    } else if (subCmd === "list") {
      const repos = router.listRepos();
      if (repos.length === 0) {
        await ctx.reply(
          "<b>No repositories registered</b>\n\n" +
            "Use <code>/repo add /path/to/repo [alias]</code> to add one.",
          { parse_mode: "HTML" }
        );
        return;
      }

      const current = router.getCurrentRepo(chatId)?.alias;
      const lines = repos
        .map((r) => {
          const check = r.alias === current ? " ✓" : "";
          return `<b>${escapeHtml(r.alias)}${check}</b>\n<code>${escapeHtml(r.path)}</code>`;
        })
        .join("\n\n");

      await ctx.reply(
        `<b>Registered Repositories</b>\n\n${lines}\n\n` +
          `Use <code>/repo switch &lt;alias&gt;</code> to switch.`,
        { parse_mode: "HTML" }
      );
    } else if (subCmd === "switch") {
      if (!subArg) {
        await ctx.reply(
          "<b>Switch Repository</b>\n\n" +
            "<code>/repo switch &lt;alias&gt;</code>\n\n" +
            "Use <code>/repo list</code> to see available repositories.",
          { parse_mode: "HTML" }
        );
        return;
      }

      const repo = getRepoByAlias(subArg);
      if (!repo) {
        await ctx.reply(`<b>Repository not found:</b> <code>${escapeHtml(subArg)}</code>\n\nUse <code>/repo list</code> to see available repos.`, {
          parse_mode: "HTML",
        });
        return;
      }

      router.switchRepo(chatId, repo.path);
      await ctx.reply(
        `<b>Switched to Repository</b>\n\n` +
          `<b>Alias:</b> <code>${escapeHtml(repo.alias)}</code>\n` +
          `<b>Path:</b> <code>${escapeHtml(repo.path)}</code>`,
        { parse_mode: "HTML" }
      );
    } else if (subCmd === "remove") {
      if (!subArg) {
        await ctx.reply(
          "<b>Remove Repository</b>\n\n" +
            "<code>/repo remove &lt;alias&gt;</code>\n\n" +
            "Use <code>/repo list</code> to see available repositories.",
          { parse_mode: "HTML" }
        );
        return;
      }

      const repo = getRepoByAlias(subArg);
      if (!repo) {
        await ctx.reply(`<b>Repository not found:</b> <code>${escapeHtml(subArg)}</code>`, { parse_mode: "HTML" });
        return;
      }

      router.removeRepo(repo.path);
      removeRepoFromDisk(subArg);
      await ctx.reply(
        `<b>Repository Removed</b>\n\n` +
          `<code>${escapeHtml(repo.alias)}</code> has been removed.\n\n` +
          `<i>Note: The directory was not deleted, only unregistered from Elsa.</i>`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.reply(
        "<b>Repository Management</b>\n\n" +
          "<code>/repo add &lt;path&gt; [alias]</code> — Register a repository\n" +
          "<code>/repo list</code> — Show all repositories\n" +
          "<code>/repo switch &lt;alias&gt;</code> — Switch to a repository\n" +
          "<code>/repo remove &lt;alias&gt;</code> — Unregister a repository",
        { parse_mode: "HTML" }
      );
    }
  });

  // --- Cron commands (scheduled tasks) ---

  const SCHEDULE_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to confirm

  bot.command("cron", async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.match?.trim() || "";
    const spaceIdx = args.indexOf(" ");
    const subCmd = spaceIdx === -1 ? args.toLowerCase() : args.slice(0, spaceIdx).toLowerCase();
    const subArg = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

    if (subCmd === "add") {
      if (!subArg) {
        await ctx.reply(
          "<b>新增排程任務</b>\n\n" +
            "使用自然語言描述，例如：\n" +
            "<code>/cron add 每天早上 9 點執行測試並修復錯誤</code>\n" +
            "<code>/cron add every monday write changelog from last week's commits</code>\n" +
            "<code>/cron add every 6 hours check for new dependency vulnerabilities</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      await ctx.reply("解析排程中...");

      const parsed = await parseScheduleWithClaude(subArg);
      if (!parsed) {
        await ctx.reply("無法解析排程。請更具體描述，例如 <code>/cron add 每天早上 9 點執行測試</code>", { parse_mode: "HTML" });
        return;
      }

      const timer = setTimeout(() => {
        pendingScheduleConfirm.delete(chatId);
        bot.api.sendMessage(chatId, "排程確認已逾時。請重新使用 /cron add 新增。").catch(() => {});
      }, SCHEDULE_CONFIRM_TIMEOUT_MS);

      pendingScheduleConfirm.set(chatId, {
        schedule: {
          botId: botConfig.id,
          chatId,
          prompt: parsed.prompt,
          cronExpr: parsed.cronExpr,
          humanLabel: parsed.humanLabel,
          ...(parsed.once && { once: true }),
        },
        timer,
      });

      const keyboard = new InlineKeyboard()
        .text("Confirm", `cron:confirm:${chatId}`)
        .text("Cancel", `cron:cancel:${chatId}`);

      await ctx.reply(
        "<b>確認排程</b>\n\n" +
          `<b>時間：</b> ${escapeHtml(parsed.humanLabel)}${parsed.once ? " (一次性)" : ""}\n` +
          `<b>任務：</b> ${escapeHtml(parsed.prompt)}\n\n` +
          "<i>排程任務將自動執行，不需人工核准。</i>",
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } else if (subCmd === "list") {
      const schedules = scheduleManager.getForBot(botConfig.id);
      if (schedules.length === 0) {
        await ctx.reply("目前沒有排程任務。使用 /cron add 新增。");
        return;
      }

      const lines = schedules.map((s, i) => {
        const lastRun = s.lastRunAt
          ? `上次執行：${new Date(s.lastRunAt).toLocaleString()}`
          : "尚未執行";
        return `<b>[${i + 1}]</b> ${escapeHtml(s.humanLabel)}\n${escapeHtml(s.prompt)}\n<i>${lastRun}</i>`;
      });

      await ctx.reply(
        `<b>${escapeHtml(repoName)} 的排程任務</b>\n\n` +
          lines.join("\n\n") +
          "\n\n使用 /cron del &lt;編號&gt; 移除。",
        { parse_mode: "HTML" }
      );
    } else if (subCmd === "del") {
      if (!subArg) {
        await ctx.reply("用法：<code>/cron del &lt;編號&gt;</code>\n\n使用 /cron list 查看清單。", { parse_mode: "HTML" });
        return;
      }

      const schedules = scheduleManager.getForBot(botConfig.id);
      const idx = parseInt(subArg, 10) - 1;

      if (isNaN(idx) || idx < 0 || idx >= schedules.length) {
        await ctx.reply("無效的編號。使用 /cron list 查看清單。");
        return;
      }

      const schedule = schedules[idx];
      scheduleManager.remove(schedule.id);
      await ctx.reply(`已移除：<b>${escapeHtml(schedule.humanLabel)}</b>`, { parse_mode: "HTML" });
    } else {
      await ctx.reply(
        "<b>排程管理</b>\n\n" +
          "<code>/cron add [任務描述]</code> — 新增排程\n" +
          "<code>/cron list</code> — 列出排程\n" +
          "<code>/cron del [編號]</code> — 移除排程",
        { parse_mode: "HTML" }
      );
    }
  });

  // --- Tunnel commands ---

  tunnelManager.setAutoCloseCallback(async (chatId, port) => {
    await bot.api.sendMessage(chatId, `Preview tunnel for port ${port} closed (30 min inactivity). Use /preview to reopen.`).catch(() => {});
  });

  async function openTunnelAndNotify(chatId: number, port: number): Promise<void> {
    try {
      const url = await tunnelManager.openTunnel(chatId, port);
      const keyboard = new InlineKeyboard().text("Close Preview", `tunnel:close:${chatId}`);
      await bot.api.sendMessage(
        chatId,
        `Live preview: ${url}\n\nPort ${port}. Open on your phone!`,
        { reply_markup: keyboard }
      );
    } catch (err) {
      await bot.api.sendMessage(chatId, `Tunnel error: ${(err as Error).message}`);
    }
  }

  const PREVIEW_PROMPT =
    "Start the dev server for this project. Install any missing dependencies if needed. " +
    "If you encounter errors, fix them and retry.\n\n" +
    "Once the server is running, expose it publicly using ngrok. " +
    "Install ngrok CLI if it's not already installed (e.g. `brew install ngrok` or `npm install -g ngrok`). " +
    `The ngrok auth token is stored in the NGROK_AUTH_TOKEN environment variable or in the project's config file at ${CONFIG_FILE}.\n\n` +
    "Run: ngrok http <PORT> (where PORT is the dev server port).\n" +
    "Share the public ngrok URL in your response so I can open it on my phone.";

  bot.command("preview", async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.trim();

    // Explicit port: bot opens ngrok tunnel directly (fast, no Claude needed)
    if (arg) {
      // Check ngrok token for direct tunnel
      if (!config.NGROK_AUTH_TOKEN) {
        const timer = setTimeout(() => {
          pendingNgrokSetup.delete(chatId);
        }, NGROK_SETUP_TIMEOUT_MS);
        pendingNgrokSetup.set(chatId, { port: parsePort(arg) || 0, timer });
        await ctx.reply(
          "To use live preview, you need an ngrok auth token.\n\n" +
          "1. Sign up at https://ngrok.com (free)\n" +
          "2. Copy your token from: https://dashboard.ngrok.com/get-started/your-authtoken\n\n" +
          "Paste your token here:"
        );
        return;
      }

      const port = parsePort(arg);
      if (!port) {
        await ctx.reply("Invalid port. Examples:\n/preview 3000\n/preview localhost:3000");
        return;
      }
      await openTunnelAndNotify(chatId, port);
      return;
    }

    // No port: Claude starts the dev server and sets up ngrok
    logUser("[preview] auto-start dev server + ngrok", tag);
    handlePrompt(chatId, PREVIEW_PROMPT, (text) => ctx.reply(text));
  });

  bot.command("close", async (ctx) => {
    const chatId = ctx.chat.id;
    const closed = await tunnelManager.closeTunnel(chatId);
    if (closed) {
      await ctx.reply("Preview tunnel closed.");
    } else {
      await ctx.reply("No active preview. If Claude started ngrok, tell Claude to stop it.");
    }
  });

  function handlePrompt(chatId: number, prompt: string, replyFn: (text: string) => Promise<{ message_id: number }>) {
    (async () => {
      if (router.isProcessing(chatId)) {
        await bot.api.sendMessage(chatId, "Claude is busy with a running task. Use /cancel to stop it first.");
        return;
      }

      if (router.isCoolingDown(chatId)) {
        await bot.api.sendMessage(chatId, "Slow down — wait a moment before sending again.");
        return;
      }

      router.setLastPrompt(chatId, prompt);

      bot.api.sendChatAction(chatId, "typing").catch(() => {});

      // Draft streaming state
      let thinkingMsgId: number | null = null;

      // Send initial "Thinking..." message that we'll update with streaming content
      const thinking = await replyFn("Thinking...");
      thinkingMsgId = thinking.message_id;

      const typingInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, "typing").catch(() => {});
      }, TYPING_INTERVAL_MS);

      let buffer = "";
      let currentActivity = "Thinking...";
      let lastEditTime = 0;
      let editTimer: NodeJS.Timeout | null = null;
      let lastEditedText = "";

      const doEdit = async () => {
        if (editTimer) {
          clearTimeout(editTimer);
          editTimer = null;
        }
        lastEditTime = Date.now();

        // Build plain text content (used for drafts and as fallback)
        const plainFooter = currentActivity ? `\n\n${currentActivity}` : "";
        let plainContent: string;
        if (buffer.trim()) {
          const maxLen = STREAM_MAX_LEN - plainFooter.length;
          const text = buffer.length > maxLen ? buffer.slice(0, maxLen) + "\n\n... streaming ..." : buffer;
          plainContent = text + plainFooter;
        } else {
          plainContent = (plainFooter.trim() || "Thinking...").trim();
        }

        if (!plainContent.trim() || plainContent === lastEditedText) return;
        lastEditedText = plainContent;

        // Edit the thinking message with streaming content
        if (!thinkingMsgId) return;
        const htmlFooter = currentActivity ? `\n\n<i>${escapeHtml(currentActivity)}</i>` : "";
        let htmlContent: string;
        if (buffer.trim()) {
          let html = claudeToTelegram(buffer);
          const maxLen = STREAM_MAX_LEN - htmlFooter.length;
          if (html.length > maxLen) {
            html = html.slice(0, maxLen) + "\n\n<i>... streaming ...</i>";
          }
          htmlContent = html + htmlFooter;
        } else {
          htmlContent = htmlFooter.trim() || "<i>Thinking...</i>";
        }

        try {
          await bot.api.editMessageText(chatId, thinkingMsgId, htmlContent, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.editMessageText(chatId, thinkingMsgId, plainContent);
          } catch {}
        }
      };

      const safeDoEdit = () => { doEdit().catch(() => {}); };

      const scheduleEdit = () => {
        const debounce = EDIT_DEBOUNCE_MS;
        const now = Date.now();
        if (now - lastEditTime >= debounce) {
          safeDoEdit();
        } else if (!editTimer) {
          editTimer = setTimeout(safeDoEdit, debounce - (now - lastEditTime));
        }
      };

      const onStatusUpdate = (status: string) => {
        currentActivity = status;
        scheduleEdit();
      };

      const onStreamChunk = (chunk: string) => {
        buffer += chunk;
        currentActivity = "";
        scheduleEdit();
      };

      const onPlanApproval = async (planFileContent?: string): Promise<boolean> => {
        // Cancel any pending debounce edit so thinkingMsgId doesn't flash stale content
        if (editTimer) {
          clearTimeout(editTimer);
          editTimer = null;
        }

        // Save preamble before clearing buffer
        const preamble = buffer.trim();
        buffer = "";
        currentActivity = "";

        // Clear display before sending plan as real messages
        await doEdit();

        // Combine preamble with the plan file Claude wrote
        const planBody = planFileContent?.trim() ?? "";
        const fullPlan = planBody || preamble;

        if (fullPlan) {
          const html = claudeToTelegram(fullPlan);
          const parts = splitMessage(html);
          for (const part of parts) {
            try {
              await bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
            } catch {
              await bot.api.sendMessage(chatId, part).catch(() => {});
            }
          }
        }

        currentActivity = "Waiting for plan approval...";

        const requestId = String(++approvalCounter);
        const keyboard = new InlineKeyboard()
          .text("Approve Plan", `plan:approve:${requestId}`)
          .row()
          .text("Reject Plan", `plan:reject:${requestId}`);

        const approved = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            pendingPlanActions.delete(requestId);
            resolve(false);
          }, APPROVAL_TIMEOUT_MS);

          pendingPlanActions.set(requestId, { resolve, timer });

          bot.api
            .sendMessage(chatId, "<b>Approve this plan?</b>", {
              parse_mode: "HTML",
              reply_markup: keyboard,
            })
            .catch(() => {
              clearTimeout(timer);
              pendingPlanActions.delete(requestId);
              resolve(false);
            });
        });

        return approved;
      };

      const onAskUser = async (questions: AskUserQuestion[]): Promise<Record<string, string>> => {
        // Pause streaming: cancel pending edits and clear draft ghost bubble
        // so it doesn't overwrite the inline keyboard buttons
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }

        const answers: Record<string, string> = {};

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          const requestId = String(++approvalCounter);

          const keyboard = new InlineKeyboard();
          q.options.forEach((opt, optIdx) => {
            keyboard.text(opt.label, `answer:${requestId}:${optIdx}`);
            keyboard.row();
          });
          keyboard.text("Other…", `answer:${requestId}:other`);

          const answer = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              pendingAnswers.delete(requestId);
              resolve(q.options[0]?.label || "");
            }, APPROVAL_TIMEOUT_MS);

            pendingAnswers.set(requestId, { resolve, timer, options: q.options, question: q.question });

            const desc = q.options.map((o) => `• <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description)}`).join("\n");
            bot.api
              .sendMessage(
                chatId,
                `<b>${escapeHtml(q.header)}</b>\n${escapeHtml(q.question)}\n\n${desc}`,
                { parse_mode: "HTML", reply_markup: keyboard }
              )
              .catch(() => {
                clearTimeout(timer);
                pendingAnswers.delete(requestId);
                resolve(q.options[0]?.label || "");
              });
          });

          answers[q.question] = answer;
        }

        return answers;
      };

      const onToolApproval = async (
        toolName: string,
        input: Record<string, unknown>
      ): Promise<"allow" | "always" | "deny"> => {
        // Pause streaming: cancel pending edits and clear draft ghost bubble
        // so it doesn't overwrite the inline keyboard buttons
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }

        const result = await new Promise<"allow" | "always" | "deny">((resolve) => {
          const requestId = String(++approvalCounter);

          const timer = setTimeout(() => {
            pendingApprovals.delete(requestId);
            resolve("deny");
          }, APPROVAL_TIMEOUT_MS);

          const description = formatToolCall(toolName, input);

          pendingApprovals.set(requestId, { resolve, timer, description });
          const keyboard = new InlineKeyboard()
            .text("Approve", `approve:${requestId}`)
            .text("Always Allow", `alwaysallow:${requestId}`)
            .row()
            .text("Deny", `deny:${requestId}`);

          bot.api
            .sendMessage(chatId, description, {
              parse_mode: "HTML",
              reply_markup: keyboard,
            })
            .catch(() => {
              clearTimeout(timer);
              pendingApprovals.delete(requestId);
              resolve("deny");
            });
        });

        return result;
      };

      let responseHandled = false;

      const onResult = async (result: {
        text: string;
        usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
        turns: number;
        durationMs: number;
      }) => {
        responseHandled = true;
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);

        const finalText = buffer || result.text || "Done.";

        logStream(finalText, tag);

        const html = claudeToTelegram(finalText);
        const parts = splitMessage(html);

        if (thinkingMsgId) {
          try {
            await bot.api.deleteMessage(chatId, thinkingMsgId);
          } catch {
            await bot.api
              .editMessageText(chatId, thinkingMsgId, "⏤")
              .catch(() => {});
          }
        }

        for (const part of parts) {
          try {
            await bot.api.sendMessage(chatId, part || "Done.", {
              parse_mode: "HTML",
            });
          } catch {
            await bot.api
              .sendMessage(chatId, part || "Done.")
              .catch(() => {});
          }
        }

        const seconds = (result.durationMs / 1000).toFixed(1);
        const tokens = result.usage.inputTokens + result.usage.outputTokens;
        logResult(tokens, result.turns, seconds, tag);
        await bot.api
          .sendMessage(
            chatId,
            `${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s | 📂 ${getRepoName(chatId)}`
          )
          .catch(() => {});

      };

      const onError = async (error: Error) => {
        responseHandled = true;
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        logError(error.message, tag);

        let errorMsg = error.message;
        const keyboard = new InlineKeyboard().text("Retry", `retry:${String(++retryCounter)}`);

        // Detect session not found error and suggest solutions
        if (errorMsg.includes("No conversation found") || errorMsg.includes("session") && errorMsg.includes("not found")) {
          errorMsg = (
            "❌ Session not found. The conversation file may have been deleted or moved.\n\n" +
            "Solutions:\n" +
            "1. Use /new to start a fresh session\n" +
            "2. Use /resume to pick a different session"
          );
          keyboard.text("Start Fresh", "new:fresh");
        }

        if (thinkingMsgId) {
          try {
            await bot.api.editMessageText(
              chatId,
              thinkingMsgId,
              errorMsg,
              { reply_markup: keyboard }
            );
          } catch {
            await bot.api.sendMessage(chatId, errorMsg, {
              reply_markup: keyboard,
            }).catch(() => {});
          }
        } else {
          await bot.api.sendMessage(chatId, errorMsg, {
            reply_markup: keyboard,
          }).catch(() => {});
        }
      };

      await router.sendMessage(chatId, prompt, {
        onStreamChunk,
        onStatusUpdate,
        onToolApproval,
        onAskUser,
        onPlanApproval,
        onResult,
        onError,
        onSessionReset: () => {
          bot.api.sendMessage(chatId, "Previous session not found. Starting a fresh session.").catch(() => {});
        },
      });

      // Runs if cancelled (onResult/onError were never called)
      if (!responseHandled) {
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        if (thinkingMsgId) {
          try {
            await bot.api.deleteMessage(chatId, thinkingMsgId);
          } catch {
            await bot.api.editMessageText(chatId, thinkingMsgId, "Cancelled.").catch(() => {});
          }
        }
      }
    })().catch((err) => {
      console.error(`[${tag}] handlePrompt error:`, err);
    });
  }

  function extractReplyContext(ctx: { message?: { reply_to_message?: { text?: string } } }): string {
    const quoted = ctx.message?.reply_to_message?.text;
    if (!quoted) return "";
    const preview = quoted.length > REPLY_PREVIEW_MAX ? quoted.slice(0, REPLY_PREVIEW_MAX) + "..." : quoted;
    return `[Replying to message: "${preview}"]\n\n`;
  }

  async function sendSessionHistory(chatId: number, sessionId: string): Promise<void> {
    try {
      const history = router.getSessionHistory(sessionId, 10);
      if (history.length === 0) return;

      let html = "<b>Conversation history:</b>\n\n";
      for (const entry of history) {
        if (entry.role === "user") {
          html += `<b>You:</b>\n${escapeHtml(entry.text)}\n\n`;
        } else {
          html += `<b>Claude:</b>\n${claudeToTelegram(entry.text)}\n\n`;
        }
      }

      const parts = splitMessage(html.trimEnd());
      for (const part of parts) {
        try {
          await bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(chatId, part).catch(() => {});
        }
      }
    } catch {}
  }

  bot.on("message:text", (ctx) => {
    const chatId = ctx.chat.id;

    // Reset tunnel inactivity timer on any bot activity
    tunnelManager.resetTimer(chatId);

    // Check if waiting for ngrok auth token
    const ngrokSetup = pendingNgrokSetup.get(chatId);
    if (ngrokSetup) {
      clearTimeout(ngrokSetup.timer);
      pendingNgrokSetup.delete(chatId);
      const token = ctx.message.text.trim();
      if (!token) {
        ctx.reply("No token provided. Use /preview <port> to try again.").catch(() => {});
        return;
      }

      // Save token and proceed
      tunnelManager.setAuthToken(token);
      saveNgrokToken(token);
      config.NGROK_AUTH_TOKEN = token;
      (async () => {
        await bot.api.sendMessage(chatId, "Token saved!");
        if (ngrokSetup.port) {
          // Explicit port was given before token prompt
          await openTunnelAndNotify(chatId, ngrokSetup.port);
        } else {
          // No port — Claude starts the dev server + ngrok
          handlePrompt(chatId, PREVIEW_PROMPT, (text) => bot.api.sendMessage(chatId, text));
        }
      })().catch(() => {});
      return;
    }

    // Check if waiting for a free-text answer to an AskUserQuestion
    const freeText = pendingFreeText.get(chatId);
    if (freeText) {
      clearTimeout(freeText.timer);
      pendingFreeText.delete(chatId);
      bot.api.editMessageText(chatId, freeText.msgId,
        `<b>${escapeHtml(freeText.question)}</b>\n\nAnswer: <b>${escapeHtml(ctx.message.text)}</b>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      freeText.resolve(ctx.message.text);
      return;
    }

    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + ctx.message.text;
    logUser(ctx.message.text, tag);
    handlePrompt(chatId, prompt, (text) => ctx.reply(text));
  });

  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;

    if (router.isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    const doc = ctx.message.document;
    if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`File too large (${(doc.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) {
      await ctx.reply("Error: Could not get file path from Telegram.");
      return;
    }

    const tmpDir = router.getTempDir();
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const rawName = doc.file_name || `file-${Date.now()}`;
    const fileName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const tmpFile = path.join(tmpDir, fileName);

    let arrayBuf: Buffer;
    try {
      arrayBuf = await downloadTelegramFile(botConfig.token, file.file_path);
    } catch (err) {
      await ctx.reply((err as Error).message);
      return;
    }
    fs.writeFileSync(tmpFile, arrayBuf, { mode: 0o600 });

    const caption = ctx.message.caption || `Analyze this file: ${fileName}`;
    logUser(`[document: ${fileName}] ${caption}`, tag);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you a file saved at ${tmpFile}\n\nPlease read that file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, (text) => ctx.reply(text));
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;

    if (router.isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (photo.file_size && photo.file_size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`Photo too large (${(photo.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const file = await ctx.api.getFile(photo.file_id);
    if (!file.file_path) {
      await ctx.reply("Error: Could not get file path from Telegram.");
      return;
    }

    const tmpDir = router.getTempDir();
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const ext = path.extname(file.file_path || ".jpg") || ".jpg";
    const tmpFile = path.join(tmpDir, `tg-${Date.now()}${ext}`);

    let arrayBuf: Buffer;
    try {
      arrayBuf = await downloadTelegramFile(botConfig.token, file.file_path);
    } catch (err) {
      await ctx.reply((err as Error).message);
      return;
    }
    fs.writeFileSync(tmpFile, arrayBuf, { mode: 0o600 });

    const caption = ctx.message.caption || "Describe this image.";
    logUser(`[photo] ${caption}`, tag);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you an image saved at ${tmpFile}\n\nPlease read/view that image file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, (text) => ctx.reply(text));
  });

  // Callback query handler for Approve/Deny, model selection, retry, browser
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Cron confirm/cancel
    if (data.startsWith("cron:confirm:") || data.startsWith("cron:cancel:")) {
      const parts = data.split(":");
      const action = parts[1];
      const chatId = Number(parts[2]);
      const pending = pendingScheduleConfirm.get(chatId);

      if (!pending) {
        await ctx.answerCallbackQuery("Confirmation expired").catch(() => {});
        return;
      }

      clearTimeout(pending.timer);
      pendingScheduleConfirm.delete(chatId);

      if (action === "cancel") {
        await ctx.editMessageText("排程已取消。").catch(() => {});
        await ctx.answerCallbackQuery("Cancelled").catch(() => {});
        return;
      }

      const schedule: Schedule = {
        ...pending.schedule,
        id: generateScheduleId(),
        createdAt: new Date().toISOString(),
        lastRunAt: null,
      };

      scheduleManager.add(schedule);

      await ctx.editMessageText(
        `<b>排程已儲存</b>\n\n` +
          `<b>時間：</b> ${escapeHtml(schedule.humanLabel)}\n` +
          `<b>任務：</b> ${escapeHtml(schedule.prompt)}\n\n` +
          `使用 /cron list 查看，/cron del 移除。`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery("排程已儲存").catch(() => {});
      return;
    }

    // Tunnel close
    if (data.startsWith("tunnel:close:")) {
      const chatId = Number(data.split(":")[2]);
      await ctx.answerCallbackQuery().catch(() => {});
      const closed = await tunnelManager.closeTunnel(chatId);
      const text = closed ? "Preview tunnel closed." : "No active preview.";
      await ctx.editMessageText(text).catch(() => {});
      return;
    }

    // Model selection
    const modelMatch = data.match(/^model:(.+)$/);
    if (modelMatch) {
      const modelId = modelMatch[1];
      const chatId = ctx.chat!.id;
      const label =
        AVAILABLE_MODELS.find((m) => m.id === modelId)?.label || modelId;

      router.setModel(chatId, modelId);

      await ctx.editMessageText(
        `Model switched to <b>${label}</b>\nSession reset — next message uses the new model.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery(`Switched to ${label}`).catch(() => {});
      return;
    }

    // Permission mode selection
    const modeMatch = data.match(/^mode:(.+)$/);
    if (modeMatch) {
      const modeId = modeMatch[1] as import("./claude.js").PermissionMode;
      const chatId = ctx.chat!.id;
      const label =
        AVAILABLE_PERMISSION_MODES.find((m) => m.id === modeId)?.label || modeId;

      router.setPermissionMode(chatId, modeId);

      await ctx.editMessageText(
        `Permission mode switched to <b>${label}</b>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery(`Switched to ${label}`).catch(() => {});
      return;
    }

    // Resume session selection
    const resumeMatch = data.match(/^resume:(.+)$/);
    if (resumeMatch) {
      const sessionId = resumeMatch[1];
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(sessionId)) {
        await ctx.answerCallbackQuery("Invalid session ID").catch(() => {});
        return;
      }
      const chatId = ctx.chat!.id;

      if (router.isProcessing(chatId)) {
        router.cancelQuery(chatId);
      }

      router.setSessionId(chatId, sessionId);

      await ctx.editMessageText(
        `Session resumed: <code>${sessionId}</code>\n\nSend a message to continue.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await sendSessionHistory(chatId, sessionId);
      await ctx.answerCallbackQuery("Session resumed").catch(() => {});
      return;
    }

    // Plan approval
    if (data.startsWith("plan:")) {
      const parts = data.split(":");
      const action = parts[1];
      const requestId = parts[2];
      const pending = pendingPlanActions.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery("Request expired").catch(() => {});
        return;
      }
      clearTimeout(pending.timer);
      pendingPlanActions.delete(requestId);

      const approved = action === "approve";
      pending.resolve(approved);

      await ctx.editMessageText(approved ? "Plan approved." : "Plan rejected.").catch(() => {});
      await ctx.answerCallbackQuery(approved ? "Plan approved" : "Plan rejected").catch(() => {});
      return;
    }

    // Question answer
    if (data.startsWith("answer:")) {
      const parts = data.split(":");
      const requestId = parts[1];
      const optPart = parts[2];
      const pending = pendingAnswers.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery("Request expired").catch(() => {});
        return;
      }

      if (optPart === "other") {
        // Move to free-text mode: clear options timer, wait for next message
        clearTimeout(pending.timer);
        pendingAnswers.delete(requestId);
        await ctx.answerCallbackQuery("Type your answer").catch(() => {});
        await ctx.editMessageText(
          `<b>${escapeHtml(pending.question)}</b>\n\nType your answer:`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        const chatId = ctx.chat!.id;
        const sentMsg = await bot.api.sendMessage(chatId, "Send your reply now…");
        const timer = setTimeout(() => {
          pendingFreeText.delete(chatId);
          bot.api.editMessageText(chatId, sentMsg.message_id, "Timed out waiting for answer.").catch(() => {});
          pending.resolve("");
        }, APPROVAL_TIMEOUT_MS);
        pendingFreeText.set(chatId, { resolve: pending.resolve, timer, question: pending.question, msgId: sentMsg.message_id });
        return;
      }

      const optIdx = Number(optPart);
      clearTimeout(pending.timer);
      pendingAnswers.delete(requestId);

      const selectedLabel = pending.options[optIdx]?.label || "";
      pending.resolve(selectedLabel);

      await ctx
        .editMessageText(`<b>${escapeHtml(pending.question)}</b>\n\nSelected: <b>${escapeHtml(selectedLabel)}</b>`, {
          parse_mode: "HTML",
        })
        .catch(() => {});
      await ctx.answerCallbackQuery(`Selected: ${selectedLabel}`).catch(() => {});
      return;
    }

    // Start fresh session (for error recovery)
    if (data === "new:fresh") {
      const chatId = ctx.chat!.id;
      router.clearSession(chatId);
      await ctx.editMessageText("✓ Session cleared. Ready for a fresh start.").catch(() => {});
      await ctx.answerCallbackQuery("Fresh session started").catch(() => {});
      return;
    }

    if (data.startsWith("retry:")) {
      const chatId = ctx.chat!.id;
      const lastPrompt = router.getLastPrompt(chatId);
      if (!lastPrompt) {
        await ctx.answerCallbackQuery("No previous prompt to retry.").catch(() => {});
        return;
      }
      await ctx.editMessageText(`Retrying...`).catch(() => {});
      await ctx.answerCallbackQuery("Retrying").catch(() => {});
      handlePrompt(chatId, lastPrompt, (text) =>
        bot.api.sendMessage(chatId, text)
      );
      return;
    }

    const match = data.match(/^(approve|alwaysallow|deny):(\d+)$/);
    if (!match) {
      await ctx.answerCallbackQuery("Invalid action").catch(() => {});
      return;
    }

    const [, action, requestId] = match;
    const pending = pendingApprovals.get(requestId);

    if (!pending) {
      await ctx.answerCallbackQuery("Request expired").catch(() => {});
      return;
    }

    clearTimeout(pending.timer);
    pendingApprovals.delete(requestId);

    const result: "allow" | "always" | "deny" =
      action === "approve"     ? "allow"  :
      action === "alwaysallow" ? "always" :
                                 "deny";

    pending.resolve(result);

    const statusLabel =
      result === "allow"  ? "APPROVED" :
      result === "always" ? "ALWAYS ALLOWED" :
                            "DENIED";

    try {
      await ctx.editMessageText(`[${statusLabel}]\n${pending.description}`, {
        parse_mode: "HTML",
      });
    } catch {}

    const answerText =
      result === "allow"  ? "Approved" :
      result === "always" ? "Allowed for this session" :
                            "Denied";

    await ctx.answerCallbackQuery(answerText).catch(() => {});
  });

  return bot;
}
