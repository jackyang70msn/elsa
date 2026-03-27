import { Client, GatewayIntentBits, Partials, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, } from "discord.js";
import { AVAILABLE_MODELS, AVAILABLE_PERMISSION_MODES } from "./claude.js";
import { snowflakeToNumeric } from "./store.js";
import { addRepo as addRepoToDisk, removeRepo as removeRepoFromDisk, getRepoByAlias, } from "./repo-manager.js";
import { parsePort } from "./tunnel.js";
import { parseScheduleWithClaude, generateScheduleId, } from "./scheduler.js";
import { claudeToDiscord, splitDiscordMessage, formatToolCallDiscord, } from "./discord-formatter.js";
import { logUser, logStream, logResult, logError, } from "./log.js";
import { isDiscordOwner, config } from "./config.js";
import fs from "node:fs";
import path from "node:path";
const CONFIG_FILE = path.join(config.DATA_DIR, "config.json");
const TYPING_INTERVAL_MS = 4000;
const EDIT_DEBOUNCE_MS = 1200;
const APPROVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // Discord max 8 MB
const REPLY_PREVIEW_MAX = 500;
const STREAM_MAX_LEN = 1900; // Leave room for activity footer within 2000 limit
const SCHEDULE_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const NGROK_SETUP_TIMEOUT_MS = 5 * 60 * 1000;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function downloadDiscordFile(url, maxBytes) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok)
        throw new Error(`Download failed: HTTP ${res.status}`);
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
        throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Max is ${maxBytes / 1024 / 1024} MB.`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
        throw new Error(`File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max is ${maxBytes / 1024 / 1024} MB.`);
    }
    return buf;
}
function saveNgrokToken(token) {
    let existing = {};
    try {
        existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            console.error(`Failed to parse config file, not saving ngrok token:`, error);
            return;
        }
    }
    existing.NGROK_AUTH_TOKEN = token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
}
// ---------------------------------------------------------------------------
// createDiscordWorker
// ---------------------------------------------------------------------------
export function createDiscordWorker(botConfig, router, tunnelManager, scheduleManager) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel, Partials.Message],
    });
    const tag = botConfig.username;
    /** Dynamic repo name based on the current repo for a given chatId */
    function getRepoName(chatId) {
        if (chatId !== undefined) {
            const repo = router.getCurrentRepo(chatId);
            if (repo)
                return repo.alias;
        }
        const repos = router.listRepos();
        return repos.length > 0 ? repos[0].alias : "no-repo";
    }
    // ---- Pending interaction maps ----
    const pendingApprovals = new Map();
    const pendingPlanActions = new Map();
    const pendingAnswers = new Map();
    const pendingFreeText = new Map();
    const pendingNgrokSetup = new Map();
    const pendingScheduleConfirm = new Map();
    let approvalCounter = 0;
    let retryCounter = 0;
    // ---- Authorization check ----
    function isAuthorized(channelId, userId) {
        if (isDiscordOwner(userId))
            return true;
        const numericChannel = snowflakeToNumeric(channelId);
        const numericUser = snowflakeToNumeric(userId);
        return router.isAllowedUser(numericChannel, numericUser);
    }
    // ---- Tunnel auto-close callback ----
    tunnelManager.setAutoCloseCallback(async (chatId, port) => {
        // chatId here is numeric — we can't easily reverse it to a channel,
        // so we do nothing extra. The TunnelManager handles cleanup.
        // In practice, the Telegram worker also just sends a message
        // to the chatId, but for Discord we'd need a channel reference.
        // We'll store a channel map below to handle this.
    });
    // Map numeric chatId → Discord channel for tunnel callbacks
    const channelMap = new Map();
    // ---- Help text ----
    function getHelpText(chatId) {
        const repo = chatId !== undefined ? router.getCurrentRepo(chatId) : undefined;
        const repoLine = repo
            ? `**${repo.alias}**\n\`${repo.path}\`\n\n`
            : "**No repo selected.** Use `/repo add` to add one.\n\n";
        return (repoLine +
            "Send any text or attach a file to interact with Claude Code.\n\n" +
            "**Commands:**\n" +
            "`/new` -- Start a fresh session (clears context)\n" +
            "`/model` -- Switch Claude model (Opus / Sonnet / Haiku)\n" +
            "`/cost` -- Show token usage for the current session\n" +
            "`/session` -- Get session ID to continue in CLI\n" +
            "`/resume` -- Resume a CLI session in Discord\n" +
            "`/cancel` -- Abort the current operation\n" +
            "`/allow` -- Authorize a user in this channel (owner only)\n" +
            "`/deny` -- Remove a user from this channel (owner only)\n" +
            "`/members` -- List authorized users (owner only)\n" +
            "`/help` -- Show this help message\n\n" +
            "**Repo Management:**\n" +
            "`/repo add <path>` -- Add a repo\n" +
            "`/repo list` -- List all repos\n" +
            "`/repo switch <alias>` -- Switch current repo\n" +
            "`/repo remove <alias>` -- Remove a repo\n\n" +
            "**Live Preview:**\n" +
            "`/preview [port]` -- Start dev server and open live preview\n" +
            "`/close` -- Close active preview tunnel\n\n" +
            "**Schedule:**\n" +
            "`/cron add [task]` -- Schedule a recurring task\n" +
            "`/cron list` -- List scheduled tasks\n" +
            "`/cron del [number]` -- Remove a scheduled task\n\n" +
            "**Features:**\n" +
            "- Send files (PDF, code files, etc.) for analysis\n" +
            "- Reply to any Claude message to include it as context\n" +
            "- Tap Retry on errors to re-run the last prompt\n\n" +
            "**Tips:**\n" +
            "- Send an image with a caption to ask about images\n" +
            "- Claude can read, edit, and create files in your project\n" +
            "- Some tools require your approval via Approve/Deny buttons\n" +
            "- Use `/cancel` if a response is taking too long");
    }
    // ---- Tunnel helper ----
    async function openTunnelAndNotify(channel, chatId, port) {
        try {
            const url = await tunnelManager.openTunnel(chatId, port);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
                .setCustomId(`tunnel:close:${chatId}`)
                .setLabel("Close Preview")
                .setStyle(ButtonStyle.Secondary));
            await channel.send({
                content: `Live preview: ${url}\n\nPort ${port}. Open on your phone!`,
                components: [row],
            });
        }
        catch (err) {
            await channel.send(`Tunnel error: ${err.message}`).catch(() => { });
        }
    }
    const PREVIEW_PROMPT = "Start the dev server for this project. Install any missing dependencies if needed. " +
        "If you encounter errors, fix them and retry.\n\n" +
        "Once the server is running, expose it publicly using ngrok. " +
        "Install ngrok CLI if it's not already installed (e.g. `brew install ngrok` or `npm install -g ngrok`). " +
        `The ngrok auth token is stored in the NGROK_AUTH_TOKEN environment variable or in the project's config file at ${CONFIG_FILE}.\n\n` +
        "Run: ngrok http <PORT> (where PORT is the dev server port).\n" +
        "Share the public ngrok URL in your response so I can open it on my phone.";
    // ---- Reply context extraction ----
    function extractReplyContext(referencedMessage) {
        if (!referencedMessage)
            return "";
        const quoted = referencedMessage.content;
        if (!quoted)
            return "";
        const preview = quoted.length > REPLY_PREVIEW_MAX
            ? quoted.slice(0, REPLY_PREVIEW_MAX) + "..."
            : quoted;
        return `[Replying to message: "${preview}"]\n\n`;
    }
    // ---- Session history display ----
    async function sendSessionHistory(channel, sessionId) {
        try {
            const history = router.getSessionHistory(sessionId, 10);
            if (history.length === 0)
                return;
            let text = "**Conversation history:**\n\n";
            for (const entry of history) {
                if (entry.role === "user") {
                    text += `**You:**\n${entry.text}\n\n`;
                }
                else {
                    text += `**Claude:**\n${claudeToDiscord(entry.text)}\n\n`;
                }
            }
            const parts = splitDiscordMessage(text.trimEnd());
            for (const part of parts) {
                await channel.send(part).catch(() => { });
            }
        }
        catch { }
    }
    // ---- Core handlePrompt ----
    function handlePrompt(channelId, prompt, channel) {
        (async () => {
            const numericId = snowflakeToNumeric(channelId);
            // Store channel reference for tunnel callbacks
            channelMap.set(numericId, channel);
            if (router.isProcessing(numericId)) {
                await channel.send("Claude is busy with a running task. Use `/cancel` to stop it first.").catch(() => { });
                return;
            }
            if (router.isCoolingDown(numericId)) {
                await channel.send("Slow down -- wait a moment before sending again.").catch(() => { });
                return;
            }
            router.setLastPrompt(numericId, prompt);
            // Send initial "Thinking..." message
            let thinkingMsg = null;
            try {
                thinkingMsg = await channel.send("Thinking...");
            }
            catch {
                return; // Can't send to channel at all
            }
            // Typing indicator
            const typingInterval = setInterval(() => {
                channel.sendTyping().catch(() => { });
            }, TYPING_INTERVAL_MS);
            let buffer = "";
            let currentActivity = "Thinking...";
            let lastEditTime = 0;
            let editTimer = null;
            let lastEditedText = "";
            const doEdit = async () => {
                if (editTimer) {
                    clearTimeout(editTimer);
                    editTimer = null;
                }
                lastEditTime = Date.now();
                const footer = currentActivity ? `\n\n_${currentActivity}_` : "";
                let content;
                if (buffer.trim()) {
                    const maxLen = STREAM_MAX_LEN - footer.length;
                    const text = buffer.length > maxLen
                        ? buffer.slice(buffer.length - maxLen) + "\n\n... streaming ..."
                        : buffer;
                    content = text + footer;
                }
                else {
                    content = (footer.trim() || "Thinking...").trim();
                }
                if (!content.trim() || content === lastEditedText)
                    return;
                lastEditedText = content;
                if (!thinkingMsg)
                    return;
                try {
                    await thinkingMsg.edit(content);
                }
                catch { }
            };
            const safeDoEdit = () => {
                doEdit().catch(() => { });
            };
            const scheduleEdit = () => {
                const now = Date.now();
                if (now - lastEditTime >= EDIT_DEBOUNCE_MS) {
                    safeDoEdit();
                }
                else if (!editTimer) {
                    editTimer = setTimeout(safeDoEdit, EDIT_DEBOUNCE_MS - (now - lastEditTime));
                }
            };
            const onStatusUpdate = (status) => {
                currentActivity = status;
                scheduleEdit();
            };
            const onStreamChunk = (chunk) => {
                buffer += chunk;
                currentActivity = "";
                scheduleEdit();
            };
            const onPlanApproval = async (planFileContent) => {
                // Cancel any pending debounce edit
                if (editTimer) {
                    clearTimeout(editTimer);
                    editTimer = null;
                }
                // Save preamble before clearing buffer
                const preamble = buffer.trim();
                buffer = "";
                currentActivity = "";
                // Clear the thinking message
                await doEdit();
                // Combine preamble with the plan file Claude wrote
                const planBody = planFileContent?.trim() ?? "";
                const fullPlan = planBody || preamble;
                if (fullPlan) {
                    const formatted = claudeToDiscord(fullPlan);
                    const parts = splitDiscordMessage(formatted);
                    for (const part of parts) {
                        await channel.send(part).catch(() => { });
                    }
                }
                currentActivity = "Waiting for plan approval...";
                const requestId = String(++approvalCounter);
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
                    .setCustomId(`plan:approve:${requestId}`)
                    .setLabel("Approve Plan")
                    .setStyle(ButtonStyle.Success), new ButtonBuilder()
                    .setCustomId(`plan:reject:${requestId}`)
                    .setLabel("Reject Plan")
                    .setStyle(ButtonStyle.Danger));
                const approved = await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        pendingPlanActions.delete(requestId);
                        resolve(false);
                    }, APPROVAL_TIMEOUT_MS);
                    pendingPlanActions.set(requestId, { resolve, timer });
                    channel
                        .send({ content: "**Approve this plan?**", components: [row] })
                        .catch(() => {
                        clearTimeout(timer);
                        pendingPlanActions.delete(requestId);
                        resolve(false);
                    });
                });
                return approved;
            };
            const onAskUser = async (questions) => {
                // Pause streaming
                if (editTimer) {
                    clearTimeout(editTimer);
                    editTimer = null;
                }
                const answers = {};
                for (let i = 0; i < questions.length; i++) {
                    const q = questions[i];
                    const requestId = String(++approvalCounter);
                    // Build option buttons
                    const rows = [];
                    const optionButtons = [];
                    q.options.forEach((opt, optIdx) => {
                        optionButtons.push(new ButtonBuilder()
                            .setCustomId(`answer:${requestId}:${optIdx}`)
                            .setLabel(opt.label.slice(0, 80))
                            .setStyle(ButtonStyle.Primary));
                    });
                    // "Other..." button for free text
                    optionButtons.push(new ButtonBuilder()
                        .setCustomId(`answer:${requestId}:other`)
                        .setLabel("Other...")
                        .setStyle(ButtonStyle.Secondary));
                    // Discord allows max 5 buttons per row, max 5 rows
                    for (let j = 0; j < optionButtons.length; j += 5) {
                        rows.push(new ActionRowBuilder().addComponents(optionButtons.slice(j, j + 5)));
                    }
                    const desc = q.options
                        .map((o) => `- **${o.label}** -- ${o.description}`)
                        .join("\n");
                    const answer = await new Promise((resolve) => {
                        const timer = setTimeout(() => {
                            pendingAnswers.delete(requestId);
                            resolve(q.options[0]?.label || "");
                        }, APPROVAL_TIMEOUT_MS);
                        pendingAnswers.set(requestId, {
                            resolve,
                            timer,
                            options: q.options,
                            question: q.question,
                        });
                        channel
                            .send({
                            content: `**${q.header}**\n${q.question}\n\n${desc}`,
                            components: rows,
                        })
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
            const onToolApproval = async (toolName, input) => {
                // Pause streaming
                if (editTimer) {
                    clearTimeout(editTimer);
                    editTimer = null;
                }
                const result = await new Promise((resolve) => {
                    const requestId = String(++approvalCounter);
                    const timer = setTimeout(() => {
                        pendingApprovals.delete(requestId);
                        resolve("deny");
                    }, APPROVAL_TIMEOUT_MS);
                    const description = formatToolCallDiscord(toolName, input);
                    pendingApprovals.set(requestId, { resolve, timer, description });
                    const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
                        .setCustomId(`approve:${requestId}`)
                        .setLabel("Approve")
                        .setStyle(ButtonStyle.Success), new ButtonBuilder()
                        .setCustomId(`alwaysallow:${requestId}`)
                        .setLabel("Always Allow")
                        .setStyle(ButtonStyle.Primary), new ButtonBuilder()
                        .setCustomId(`deny:${requestId}`)
                        .setLabel("Deny")
                        .setStyle(ButtonStyle.Danger));
                    channel
                        .send({ content: description, components: [row] })
                        .catch(() => {
                        clearTimeout(timer);
                        pendingApprovals.delete(requestId);
                        resolve("deny");
                    });
                });
                return result;
            };
            let responseHandled = false;
            const onResult = async (result) => {
                responseHandled = true;
                clearInterval(typingInterval);
                if (editTimer)
                    clearTimeout(editTimer);
                const finalText = buffer || result.text || "Done.";
                logStream(finalText, tag);
                const formatted = claudeToDiscord(finalText);
                const parts = splitDiscordMessage(formatted);
                // Delete the thinking message
                if (thinkingMsg) {
                    try {
                        await thinkingMsg.delete();
                    }
                    catch {
                        try {
                            await thinkingMsg.edit("--");
                        }
                        catch { }
                    }
                }
                for (const part of parts) {
                    await channel.send(part || "Done.").catch(() => { });
                }
                const seconds = (result.durationMs / 1000).toFixed(1);
                const tokens = result.usage.inputTokens + result.usage.outputTokens;
                logResult(tokens, result.turns, seconds, tag);
                await channel
                    .send(`${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s | 📂 ${getRepoName(numericId)}`)
                    .catch(() => { });
            };
            const onError = async (error) => {
                responseHandled = true;
                clearInterval(typingInterval);
                if (editTimer)
                    clearTimeout(editTimer);
                logError(error.message, tag);
                const retryId = String(++retryCounter);
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
                    .setCustomId(`retry:${retryId}`)
                    .setLabel("Retry")
                    .setStyle(ButtonStyle.Primary));
                if (thinkingMsg) {
                    try {
                        await thinkingMsg.edit({
                            content: `Error: ${error.message}`,
                            components: [row],
                        });
                    }
                    catch {
                        await channel
                            .send({ content: `Error: ${error.message}`, components: [row] })
                            .catch(() => { });
                    }
                }
                else {
                    await channel
                        .send({ content: `Error: ${error.message}`, components: [row] })
                        .catch(() => { });
                }
            };
            await router.sendMessage(numericId, prompt, {
                onStreamChunk,
                onStatusUpdate,
                onToolApproval,
                onAskUser,
                onPlanApproval,
                onResult,
                onError,
                onSessionReset: () => {
                    channel
                        .send("Previous session not found. Starting a fresh session.")
                        .catch(() => { });
                },
            });
            // Runs if cancelled (onResult/onError were never called)
            if (!responseHandled) {
                clearInterval(typingInterval);
                if (editTimer)
                    clearTimeout(editTimer);
                if (thinkingMsg) {
                    try {
                        await thinkingMsg.delete();
                    }
                    catch {
                        await thinkingMsg.edit("Cancelled.").catch(() => { });
                    }
                }
                await channel.send("Cancelled.").catch(() => { });
            }
        })().catch((err) => {
            console.error(`[${tag}] handlePrompt error:`, err);
        });
    }
    // =========================================================================
    // Events
    // =========================================================================
    // ---- Ready: register slash commands ----
    client.once("clientReady", async () => {
        console.log(`[${tag}] Discord worker ready as ${client.user?.tag}`);
        const commands = [
            new SlashCommandBuilder().setName("new").setDescription("Start a fresh session (clears context)"),
            new SlashCommandBuilder().setName("model").setDescription("Switch Claude model (Opus / Sonnet / Haiku)"),
            new SlashCommandBuilder().setName("cost").setDescription("Show token usage for the current session"),
            new SlashCommandBuilder().setName("session").setDescription("Get session ID to continue in CLI"),
            new SlashCommandBuilder().setName("resume").setDescription("Resume a CLI session in Discord"),
            new SlashCommandBuilder().setName("cancel").setDescription("Abort the current operation"),
            new SlashCommandBuilder().setName("help").setDescription("Show help text"),
            new SlashCommandBuilder()
                .setName("preview")
                .setDescription("Open ngrok tunnel for live preview")
                .addStringOption((opt) => opt.setName("port").setDescription("Port number (e.g. 3000)").setRequired(false)),
            new SlashCommandBuilder().setName("close").setDescription("Close active preview tunnel"),
            new SlashCommandBuilder()
                .setName("cron")
                .setDescription("Manage scheduled tasks")
                .addSubcommand((sub) => sub
                .setName("add")
                .setDescription("Add a scheduled task")
                .addStringOption((opt) => opt.setName("task").setDescription("e.g. daily 9am run tests").setRequired(true)))
                .addSubcommand((sub) => sub.setName("list").setDescription("List scheduled tasks"))
                .addSubcommand((sub) => sub
                .setName("del")
                .setDescription("Remove a scheduled task")
                .addIntegerOption((opt) => opt.setName("number").setDescription("Task number from /cron list").setRequired(true))),
            new SlashCommandBuilder()
                .setName("allow")
                .setDescription("Authorize a user in this channel")
                .addUserOption((opt) => opt.setName("user").setDescription("User to authorize").setRequired(true)),
            new SlashCommandBuilder()
                .setName("deny")
                .setDescription("Remove user authorization")
                .addUserOption((opt) => opt.setName("user").setDescription("User to remove").setRequired(true)),
            new SlashCommandBuilder().setName("members").setDescription("List authorized users"),
            new SlashCommandBuilder().setName("mode").setDescription("Switch permission mode (Bypass / Accept Edits / Plan)"),
            new SlashCommandBuilder()
                .setName("repo")
                .setDescription("Manage repos")
                .addSubcommand((sub) => sub
                .setName("add")
                .setDescription("Add a repo")
                .addStringOption((opt) => opt.setName("path").setDescription("Absolute path to the repo").setRequired(true))
                .addStringOption((opt) => opt.setName("alias").setDescription("Short name (optional)").setRequired(false)))
                .addSubcommand((sub) => sub.setName("list").setDescription("List all repos"))
                .addSubcommand((sub) => sub
                .setName("switch")
                .setDescription("Switch current repo")
                .addStringOption((opt) => opt.setName("alias").setDescription("Repo alias").setRequired(true)))
                .addSubcommand((sub) => sub
                .setName("remove")
                .setDescription("Remove a repo")
                .addStringOption((opt) => opt.setName("alias").setDescription("Repo alias").setRequired(true))),
        ];
        try {
            if (client.application) {
                // Clear stale global commands (may exist from previous tools using same bot token)
                const cleared = await client.application.commands.set([]);
                console.log(`[${tag}] Cleared global commands (had ${cleared.size})`);
                if (botConfig.guildId) {
                    const registered = await client.application.commands.set(commands.map((c) => c.toJSON()), botConfig.guildId);
                    console.log(`[${tag}] Registered ${registered.size} slash commands for guild ${botConfig.guildId}`);
                    for (const [, cmd] of registered) {
                        console.log(`[${tag}]   /${cmd.name}`);
                    }
                }
                else {
                    const registered = await client.application.commands.set(commands.map((c) => c.toJSON()));
                    console.log(`[${tag}] Registered ${registered.size} global slash commands`);
                }
            }
        }
        catch (err) {
            console.error(`[${tag}] Failed to register commands:`, err);
        }
    });
    // ---- interactionCreate: slash commands + buttons + selects + modals ----
    client.on("interactionCreate", async (interaction) => {
        // ---- Slash commands ----
        if (interaction.isChatInputCommand()) {
            const channelId = interaction.channelId;
            const userId = interaction.user.id;
            const numericId = snowflakeToNumeric(channelId);
            const channel = interaction.channel;
            if (!isAuthorized(channelId, userId)) {
                await interaction.reply({ content: "Unauthorized.", ephemeral: true }).catch(() => { });
                return;
            }
            switch (interaction.commandName) {
                case "help": {
                    await interaction.reply(getHelpText(numericId)).catch(() => { });
                    break;
                }
                case "new": {
                    if (router.isProcessing(numericId)) {
                        router.cancelQuery(numericId);
                    }
                    router.clearSession(numericId);
                    await interaction.reply("Session cleared. Send a message to start fresh.").catch(() => { });
                    break;
                }
                case "cost": {
                    const t = router.getSessionTokens(numericId);
                    const total = t.inputTokens + t.outputTokens;
                    await interaction
                        .reply(`**Session tokens**\n` +
                        `Input: ${t.inputTokens.toLocaleString()}\n` +
                        `Output: ${t.outputTokens.toLocaleString()}\n` +
                        `Cache write: ${t.cacheCreationTokens.toLocaleString()}\n` +
                        `Cache read: ${t.cacheReadTokens.toLocaleString()}\n` +
                        `Total: ${total.toLocaleString()}`)
                        .catch(() => { });
                    break;
                }
                case "model": {
                    const current = router.getModel(numericId);
                    const menu = new StringSelectMenuBuilder()
                        .setCustomId("model_select")
                        .setPlaceholder("Select a model");
                    for (const m of AVAILABLE_MODELS) {
                        const check = m.id === current ? " (current)" : "";
                        menu.addOptions({ label: `${m.label}${check}`, value: m.id });
                    }
                    const row = new ActionRowBuilder().addComponents(menu);
                    const currentLabel = AVAILABLE_MODELS.find((m) => m.id === current)?.label || current;
                    await interaction
                        .reply({
                        content: `Current model: **${currentLabel}**\n\nSelect a model:`,
                        components: [row],
                    })
                        .catch(() => { });
                    break;
                }
                case "mode": {
                    const current = router.getPermissionMode(numericId);
                    const menu = new StringSelectMenuBuilder()
                        .setCustomId("mode_select")
                        .setPlaceholder("Select a permission mode");
                    for (const m of AVAILABLE_PERMISSION_MODES) {
                        const check = m.id === current ? " (current)" : "";
                        menu.addOptions({ label: `${m.label}${check}`, description: m.description, value: m.id });
                    }
                    const row = new ActionRowBuilder().addComponents(menu);
                    const currentLabel = AVAILABLE_PERMISSION_MODES.find((m) => m.id === current)?.label || current;
                    await interaction
                        .reply({
                        content: `Current mode: **${currentLabel}**\n\nSelect a permission mode:`,
                        components: [row],
                    })
                        .catch(() => { });
                    break;
                }
                case "cancel": {
                    if (router.cancelQuery(numericId)) {
                        await interaction.reply("Operation cancelled.").catch(() => { });
                    }
                    else {
                        await interaction.reply("Nothing running to cancel.").catch(() => { });
                    }
                    break;
                }
                case "session": {
                    const sessionId = router.getSessionId(numericId);
                    if (!sessionId) {
                        await interaction
                            .reply("No active session. Send a message first to start one.")
                            .catch(() => { });
                        break;
                    }
                    const cmd = `claude --resume ${sessionId}`;
                    await interaction
                        .reply(`**Session ID**\n\`${sessionId}\`\n\n` +
                        `**Continue in CLI**\n` +
                        `Run this from \`${router.getCurrentRepo(numericId)?.path || "your project"}\`:\n\n` +
                        `\`${cmd}\`\n\n` +
                        `Copy the command above to use it.`)
                        .catch(() => { });
                    break;
                }
                case "resume": {
                    // List recent sessions as a select menu
                    const sessions = router.listRecentSessions(8);
                    if (sessions.length === 0) {
                        await interaction
                            .reply("No CLI sessions found for this project directory.")
                            .catch(() => { });
                        break;
                    }
                    const menu = new StringSelectMenuBuilder()
                        .setCustomId("resume_select")
                        .setPlaceholder("Select a session to resume");
                    for (const s of sessions) {
                        const dateStr = s.modifiedAt.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                        }) +
                            ", " +
                            s.modifiedAt.toLocaleTimeString("en-US", {
                                hour: "2-digit",
                                minute: "2-digit",
                            });
                        const label = `${dateStr} -- ${s.promptPreview}`;
                        const truncatedLabel = label.length > 100 ? label.slice(0, 97) + "..." : label;
                        menu.addOptions({
                            label: truncatedLabel,
                            value: s.sessionId,
                        });
                    }
                    const row = new ActionRowBuilder().addComponents(menu);
                    await interaction
                        .reply({
                        content: "Select a session to resume:",
                        components: [row],
                    })
                        .catch(() => { });
                    break;
                }
                case "preview": {
                    const portArg = interaction.options.getString("port");
                    if (portArg) {
                        // Check ngrok token
                        if (!config.NGROK_AUTH_TOKEN) {
                            const timer = setTimeout(() => {
                                pendingNgrokSetup.delete(channelId);
                            }, NGROK_SETUP_TIMEOUT_MS);
                            pendingNgrokSetup.set(channelId, {
                                port: parsePort(portArg) || 0,
                                timer,
                            });
                            await interaction
                                .reply("To use live preview, you need an ngrok auth token.\n\n" +
                                "1. Sign up at https://ngrok.com (free)\n" +
                                "2. Copy your token from: https://dashboard.ngrok.com/get-started/your-authtoken\n\n" +
                                "Paste your token here as a message:")
                                .catch(() => { });
                            break;
                        }
                        const port = parsePort(portArg);
                        if (!port) {
                            await interaction
                                .reply("Invalid port. Examples:\n`/preview 3000`\n`/preview localhost:3000`")
                                .catch(() => { });
                            break;
                        }
                        await interaction.deferReply().catch(() => { });
                        if (channel) {
                            channelMap.set(numericId, channel);
                            await openTunnelAndNotify(channel, numericId, port);
                            await interaction.deleteReply().catch(() => { });
                        }
                    }
                    else {
                        // No port: Claude starts the dev server
                        await interaction.reply("Starting dev server with Claude...").catch(() => { });
                        if (channel) {
                            logUser("[preview] auto-start dev server + ngrok", tag);
                            handlePrompt(channelId, PREVIEW_PROMPT, channel);
                        }
                    }
                    break;
                }
                case "close": {
                    const closed = await tunnelManager.closeTunnel(numericId);
                    if (closed) {
                        await interaction.reply("Preview tunnel closed.").catch(() => { });
                    }
                    else {
                        await interaction
                            .reply("No active preview. If Claude started ngrok, tell Claude to stop it.")
                            .catch(() => { });
                    }
                    break;
                }
                case "cron": {
                    const sub = interaction.options.getSubcommand();
                    if (sub === "add") {
                        const input = interaction.options.getString("task");
                        if (!input) {
                            await interaction
                                .reply("**Schedule a recurring task**\n\n" +
                                "Usage: `/cron add task:daily 9am run tests`\n" +
                                "Examples:\n" +
                                "- `/cron add task:every monday write changelog from last week's commits`\n" +
                                "- `/cron add task:every 6 hours check for new dependency vulnerabilities`")
                                .catch(() => { });
                            break;
                        }
                        await interaction.deferReply().catch(() => { });
                        const parsed = await parseScheduleWithClaude(input);
                        if (!parsed) {
                            await interaction
                                .editReply("Could not parse schedule. Try being more specific, e.g. `/cron add task:daily 9am run tests`")
                                .catch(() => { });
                            break;
                        }
                        const schedTimer = setTimeout(() => {
                            pendingScheduleConfirm.delete(channelId);
                            if (channel) {
                                channel
                                    .send("Schedule confirmation timed out. Send `/cron add` to try again.")
                                    .catch(() => { });
                            }
                        }, SCHEDULE_CONFIRM_TIMEOUT_MS);
                        pendingScheduleConfirm.set(channelId, {
                            schedule: {
                                botId: snowflakeToNumeric(botConfig.id),
                                chatId: numericId,
                                prompt: parsed.prompt,
                                cronExpr: parsed.cronExpr,
                                humanLabel: parsed.humanLabel,
                                platform: "discord",
                                channelId,
                                ...(parsed.once && { once: true }),
                            },
                            timer: schedTimer,
                        });
                        const confirmRow = new ActionRowBuilder().addComponents(new ButtonBuilder()
                            .setCustomId(`cron:confirm:${channelId}`)
                            .setLabel("Confirm")
                            .setStyle(ButtonStyle.Success), new ButtonBuilder()
                            .setCustomId(`cron:cancel:${channelId}`)
                            .setLabel("Cancel")
                            .setStyle(ButtonStyle.Danger));
                        await interaction
                            .editReply({
                            content: "**Confirm schedule**\n\n" +
                                `**When:** ${parsed.humanLabel}${parsed.once ? " (one-time)" : ""}\n` +
                                `**Task:** ${parsed.prompt}\n\n` +
                                "_Scheduled tasks run automatically without approval prompts._",
                            components: [confirmRow],
                        })
                            .catch(() => { });
                    }
                    else if (sub === "list") {
                        const botNumericId = snowflakeToNumeric(botConfig.id);
                        const schedules = scheduleManager.getForBot(botNumericId);
                        if (schedules.length === 0) {
                            await interaction
                                .reply("No scheduled tasks. Use `/cron add` to add one.")
                                .catch(() => { });
                            break;
                        }
                        const lines = schedules.map((s, i) => {
                            const lastRun = s.lastRunAt
                                ? `Last run: ${new Date(s.lastRunAt).toLocaleString()}`
                                : "Never run";
                            return `**[${i + 1}]** ${s.humanLabel}\n${s.prompt}\n_${lastRun}_`;
                        });
                        await interaction
                            .reply(`**Scheduled tasks for ${getRepoName(numericId)}**\n\n` +
                            lines.join("\n\n") +
                            "\n\nUse `/cron del` to remove.")
                            .catch(() => { });
                    }
                    else if (sub === "del") {
                        const num = interaction.options.getInteger("number");
                        if (num === null) {
                            await interaction
                                .reply("Usage: `/cron del number:1`\n\nUse `/cron list` to see the list.")
                                .catch(() => { });
                            break;
                        }
                        const botNumericId2 = snowflakeToNumeric(botConfig.id);
                        const allSchedules = scheduleManager.getForBot(botNumericId2);
                        const idx = num - 1;
                        if (idx < 0 || idx >= allSchedules.length) {
                            await interaction
                                .reply("Invalid number. Use `/cron list` to see the list.")
                                .catch(() => { });
                            break;
                        }
                        const sched = allSchedules[idx];
                        scheduleManager.remove(sched.id);
                        await interaction
                            .reply(`Removed: **${sched.humanLabel}**`)
                            .catch(() => { });
                    }
                    break;
                }
                case "allow": {
                    if (!isDiscordOwner(userId)) {
                        await interaction
                            .reply({ content: "Only the owner can manage permissions.", ephemeral: true })
                            .catch(() => { });
                        break;
                    }
                    const targetUser = interaction.options.getUser("user");
                    if (!targetUser) {
                        await interaction
                            .reply({ content: "Please specify a user.", ephemeral: true })
                            .catch(() => { });
                        break;
                    }
                    if (targetUser.bot) {
                        await interaction
                            .reply({ content: "Cannot authorize a bot.", ephemeral: true })
                            .catch(() => { });
                        break;
                    }
                    if (isDiscordOwner(targetUser.id)) {
                        await interaction
                            .reply({ content: "Owner is already authorized everywhere.", ephemeral: true })
                            .catch(() => { });
                        break;
                    }
                    const numericTarget = snowflakeToNumeric(targetUser.id);
                    router.allowUser(numericId, numericTarget);
                    await interaction
                        .reply(`Authorized user ${targetUser.tag} (\`${targetUser.id}\`) in this channel.`)
                        .catch(() => { });
                    break;
                }
                case "deny": {
                    if (!isDiscordOwner(userId)) {
                        await interaction
                            .reply({ content: "Only the owner can manage permissions.", ephemeral: true })
                            .catch(() => { });
                        break;
                    }
                    const denyTarget = interaction.options.getUser("user");
                    if (!denyTarget) {
                        await interaction
                            .reply({ content: "Please specify a user.", ephemeral: true })
                            .catch(() => { });
                        break;
                    }
                    const numericDeny = snowflakeToNumeric(denyTarget.id);
                    if (router.denyUser(numericId, numericDeny)) {
                        await interaction
                            .reply(`Removed user ${denyTarget.tag} from this channel.`)
                            .catch(() => { });
                    }
                    else {
                        await interaction
                            .reply(`User ${denyTarget.tag} was not in the allowed list.`)
                            .catch(() => { });
                    }
                    break;
                }
                case "members": {
                    if (!isDiscordOwner(userId)) {
                        await interaction
                            .reply({ content: "Only the owner can view permissions.", ephemeral: true })
                            .catch(() => { });
                        break;
                    }
                    const allowed = router.getAllowedUsers(numericId);
                    const ownerList = config.DISCORD_OWNER_IDS.map((id) => `  - ${id} (owner)`).join("\n");
                    if (allowed.length === 0) {
                        await interaction
                            .reply(`**Authorized users:**\n${ownerList}\n\nNo additional users allowed in this channel.`)
                            .catch(() => { });
                    }
                    else {
                        const userList = allowed.map((id) => `  - ${id}`).join("\n");
                        await interaction
                            .reply(`**Authorized users:**\n${ownerList}\n\n**Channel-specific:**\n${userList}`)
                            .catch(() => { });
                    }
                    break;
                }
                case "repo": {
                    if (!isDiscordOwner(userId)) {
                        await interaction.reply({ content: "Only the owner can manage repos.", ephemeral: true }).catch(() => { });
                        break;
                    }
                    const sub = interaction.options.getSubcommand();
                    if (sub === "add") {
                        const repoPath = interaction.options.getString("path");
                        const alias = interaction.options.getString("alias") || undefined;
                        try {
                            const repoConfig = addRepoToDisk(repoPath, alias);
                            router.addRepo(repoConfig);
                            await interaction
                                .reply(`Repo added: **${repoConfig.alias}** → \`${repoConfig.path}\``)
                                .catch(() => { });
                        }
                        catch (err) {
                            await interaction
                                .reply({ content: `Failed: ${err.message}`, ephemeral: true })
                                .catch(() => { });
                        }
                    }
                    else if (sub === "list") {
                        const repos = router.listRepos();
                        if (repos.length === 0) {
                            await interaction.reply("No repos. Use `/repo add` to add one.").catch(() => { });
                            break;
                        }
                        const current = router.getCurrentRepo(numericId);
                        const lines = repos.map((r) => {
                            const marker = current && r.path === current.path ? " ← current" : "";
                            return `- **${r.alias}**${marker}\n  \`${r.path}\``;
                        });
                        await interaction.reply(`**Repos**\n\n${lines.join("\n")}`).catch(() => { });
                    }
                    else if (sub === "switch") {
                        const alias = interaction.options.getString("alias");
                        const repo = getRepoByAlias(alias);
                        if (!repo) {
                            await interaction
                                .reply({ content: `Repo not found: ${alias}`, ephemeral: true })
                                .catch(() => { });
                            break;
                        }
                        if (router.isProcessing(numericId)) {
                            await interaction
                                .reply({ content: "Cannot switch while a query is running. Use `/cancel` first.", ephemeral: true })
                                .catch(() => { });
                            break;
                        }
                        try {
                            router.switchRepo(numericId, repo.path);
                            await interaction
                                .reply(`Switched to **${repo.alias}** → \`${repo.path}\``)
                                .catch(() => { });
                        }
                        catch (err) {
                            await interaction
                                .reply({ content: `Failed: ${err.message}`, ephemeral: true })
                                .catch(() => { });
                        }
                    }
                    else if (sub === "remove") {
                        const alias = interaction.options.getString("alias");
                        const repo = getRepoByAlias(alias);
                        if (!repo) {
                            await interaction
                                .reply({ content: `Repo not found: ${alias}`, ephemeral: true })
                                .catch(() => { });
                            break;
                        }
                        router.removeRepo(repo.path);
                        removeRepoFromDisk(alias);
                        await interaction
                            .reply(`Removed repo: **${alias}**`)
                            .catch(() => { });
                    }
                    break;
                }
            }
            return;
        }
        // ---- String select menu interactions ----
        if (interaction.isStringSelectMenu()) {
            const channelId = interaction.channelId;
            const numericId = snowflakeToNumeric(channelId);
            const channel = interaction.channel;
            if (!isAuthorized(channelId, interaction.user.id)) {
                await interaction.reply({ content: "Unauthorized.", ephemeral: true }).catch(() => { });
                return;
            }
            if (interaction.customId === "model_select") {
                const modelId = interaction.values[0];
                const label = AVAILABLE_MODELS.find((m) => m.id === modelId)?.label || modelId;
                router.setModel(numericId, modelId);
                await interaction
                    .update({
                    content: `Model switched to **${label}**\nSession reset -- next message uses the new model.`,
                    components: [],
                })
                    .catch(() => { });
                return;
            }
            if (interaction.customId === "mode_select") {
                const modeId = interaction.values[0];
                const label = AVAILABLE_PERMISSION_MODES.find((m) => m.id === modeId)?.label || modeId;
                router.setPermissionMode(numericId, modeId);
                await interaction
                    .update({
                    content: `Permission mode switched to **${label}**`,
                    components: [],
                })
                    .catch(() => { });
                return;
            }
            if (interaction.customId === "resume_select") {
                const sessionId = interaction.values[0];
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (!uuidRegex.test(sessionId)) {
                    await interaction
                        .update({ content: "Invalid session ID.", components: [] })
                        .catch(() => { });
                    return;
                }
                if (router.isProcessing(numericId)) {
                    router.cancelQuery(numericId);
                }
                router.setSessionId(numericId, sessionId);
                await interaction
                    .update({
                    content: `Session resumed: \`${sessionId}\`\n\nSend a message to continue.`,
                    components: [],
                })
                    .catch(() => { });
                if (channel) {
                    await sendSessionHistory(channel, sessionId);
                }
                return;
            }
            if (interaction.customId === "repo_switch_select") {
                const repoPath = interaction.values[0];
                if (router.isProcessing(numericId)) {
                    await interaction
                        .update({ content: "Cannot switch while a query is running. Use `/cancel` first.", components: [] })
                        .catch(() => { });
                    return;
                }
                try {
                    router.switchRepo(numericId, repoPath);
                    const repo = router.getCurrentRepo(numericId);
                    await interaction
                        .update({
                        content: `Switched to **${repo?.alias || path.basename(repoPath)}** → \`${repoPath}\``,
                        components: [],
                    })
                        .catch(() => { });
                }
                catch (err) {
                    await interaction
                        .update({ content: `Failed: ${err.message}`, components: [] })
                        .catch(() => { });
                }
                return;
            }
            return;
        }
        // ---- Button interactions ----
        if (interaction.isButton()) {
            const data = interaction.customId;
            const channelId = interaction.channelId;
            const numericId = snowflakeToNumeric(channelId);
            const channel = interaction.channel;
            if (!isAuthorized(channelId, interaction.user.id)) {
                await interaction.reply({ content: "Unauthorized.", ephemeral: true }).catch(() => { });
                return;
            }
            // Schedule confirm/cancel
            if (data.startsWith("cron:confirm:") || data.startsWith("cron:cancel:")) {
                const parts = data.split(":");
                const action = parts[1];
                const pendingChannelId = parts[2];
                const pending = pendingScheduleConfirm.get(pendingChannelId);
                if (!pending) {
                    await interaction
                        .update({ content: "Confirmation expired.", components: [] })
                        .catch(() => { });
                    return;
                }
                clearTimeout(pending.timer);
                pendingScheduleConfirm.delete(pendingChannelId);
                if (action === "cancel") {
                    await interaction
                        .update({ content: "Schedule cancelled.", components: [] })
                        .catch(() => { });
                    return;
                }
                const schedule = {
                    ...pending.schedule,
                    id: generateScheduleId(),
                    createdAt: new Date().toISOString(),
                    lastRunAt: null,
                };
                scheduleManager.add(schedule);
                await interaction
                    .update({
                    content: `**Schedule saved**\n\n` +
                        `**When:** ${schedule.humanLabel}\n` +
                        `**Task:** ${schedule.prompt}\n\n` +
                        `Use \`/cron list\` to view or \`/cron del\` to remove.`,
                    components: [],
                })
                    .catch(() => { });
                return;
            }
            // Tunnel close
            if (data.startsWith("tunnel:close:")) {
                const chatId = Number(data.split(":")[2]);
                const closed = await tunnelManager.closeTunnel(chatId);
                const text = closed ? "Preview tunnel closed." : "No active preview.";
                await interaction
                    .update({ content: text, components: [] })
                    .catch(() => { });
                return;
            }
            // Plan approval
            if (data.startsWith("plan:")) {
                const parts = data.split(":");
                const action = parts[1];
                const requestId = parts[2];
                const pending = pendingPlanActions.get(requestId);
                if (!pending) {
                    await interaction
                        .update({ content: "Request expired.", components: [] })
                        .catch(() => { });
                    return;
                }
                clearTimeout(pending.timer);
                pendingPlanActions.delete(requestId);
                const approved = action === "approve";
                pending.resolve(approved);
                await interaction
                    .update({
                    content: approved ? "Plan approved." : "Plan rejected.",
                    components: [],
                })
                    .catch(() => { });
                return;
            }
            // Question answer
            if (data.startsWith("answer:")) {
                const parts = data.split(":");
                const requestId = parts[1];
                const optPart = parts[2];
                const pending = pendingAnswers.get(requestId);
                if (!pending) {
                    await interaction
                        .update({ content: "Request expired.", components: [] })
                        .catch(() => { });
                    return;
                }
                if (optPart === "other") {
                    // Show a modal for free text input
                    const modal = new ModalBuilder()
                        .setCustomId(`freetext:${requestId}`)
                        .setTitle("Type your answer");
                    const textInput = new TextInputBuilder()
                        .setCustomId("answer_input")
                        .setLabel(pending.question.slice(0, 45) || "Your answer")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);
                    const actionRow = new ActionRowBuilder().addComponents(textInput);
                    modal.addComponents(actionRow);
                    await interaction.showModal(modal).catch(() => {
                        // If modal fails, fall back: resolve with empty
                        clearTimeout(pending.timer);
                        pendingAnswers.delete(requestId);
                        pending.resolve("");
                    });
                    return;
                }
                const optIdx = Number(optPart);
                clearTimeout(pending.timer);
                pendingAnswers.delete(requestId);
                const selectedLabel = pending.options[optIdx]?.label || "";
                pending.resolve(selectedLabel);
                await interaction
                    .update({
                    content: `**${pending.question}**\n\nSelected: **${selectedLabel}**`,
                    components: [],
                })
                    .catch(() => { });
                return;
            }
            // Retry
            if (data.startsWith("retry:")) {
                const lastPrompt = router.getLastPrompt(numericId);
                if (!lastPrompt) {
                    await interaction
                        .update({ content: "No previous prompt to retry.", components: [] })
                        .catch(() => { });
                    return;
                }
                await interaction
                    .update({ content: "Retrying...", components: [] })
                    .catch(() => { });
                if (channel) {
                    handlePrompt(channelId, lastPrompt, channel);
                }
                return;
            }
            // Tool approval: approve / alwaysallow / deny
            const match = data.match(/^(approve|alwaysallow|deny):(\d+)$/);
            if (match) {
                const [, action, requestId] = match;
                const pending = pendingApprovals.get(requestId);
                if (!pending) {
                    await interaction
                        .update({ content: "Request expired.", components: [] })
                        .catch(() => { });
                    return;
                }
                clearTimeout(pending.timer);
                pendingApprovals.delete(requestId);
                const result = action === "approve"
                    ? "allow"
                    : action === "alwaysallow"
                        ? "always"
                        : "deny";
                pending.resolve(result);
                const statusLabel = result === "allow"
                    ? "APPROVED"
                    : result === "always"
                        ? "ALWAYS ALLOWED"
                        : "DENIED";
                await interaction
                    .update({
                    content: `[${statusLabel}]\n${pending.description}`,
                    components: [],
                })
                    .catch(() => { });
                return;
            }
            // Unknown button
            await interaction.reply({ content: "Unknown action.", ephemeral: true }).catch(() => { });
            return;
        }
        // ---- Modal submit (free text answer) ----
        if (interaction.isModalSubmit()) {
            const data = interaction.customId;
            if (data.startsWith("freetext:")) {
                const requestId = data.split(":")[1];
                const pending = pendingAnswers.get(requestId);
                const answerText = interaction.fields.getTextInputValue("answer_input");
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingAnswers.delete(requestId);
                    pending.resolve(answerText);
                }
                await interaction
                    .reply({
                    content: `Answer submitted: **${answerText}**`,
                    ephemeral: true,
                })
                    .catch(() => { });
                return;
            }
        }
    });
    // ---- messageCreate: text + file handling ----
    client.on("messageCreate", async (message) => {
        // Ignore bot messages
        if (message.author.bot)
            return;
        // Only handle guild text channels and DMs
        if (message.channel.type !== ChannelType.GuildText &&
            message.channel.type !== ChannelType.DM) {
            return;
        }
        // In guild channels, only respond when this bot is @mentioned
        const botId = client.user?.id;
        if (message.channel.type === ChannelType.GuildText && botId) {
            if (!message.mentions.users.has(botId))
                return;
        }
        const channelId = message.channelId;
        const userId = message.author.id;
        const numericId = snowflakeToNumeric(channelId);
        const channel = message.channel;
        // Authorization check
        if (!isAuthorized(channelId, userId))
            return;
        // Store channel reference
        channelMap.set(numericId, channel);
        // Reset tunnel inactivity timer on any bot activity
        tunnelManager.resetTimer(numericId);
        // Check if waiting for ngrok auth token
        const ngrokSetup = pendingNgrokSetup.get(channelId);
        if (ngrokSetup) {
            clearTimeout(ngrokSetup.timer);
            pendingNgrokSetup.delete(channelId);
            const token = message.content.trim();
            if (!token) {
                channel.send("No token provided. Use `/preview` to try again.").catch(() => { });
                return;
            }
            tunnelManager.setAuthToken(token);
            saveNgrokToken(token);
            config.NGROK_AUTH_TOKEN = token;
            (async () => {
                await channel.send("Token saved!");
                if (ngrokSetup.port) {
                    await openTunnelAndNotify(channel, numericId, ngrokSetup.port);
                }
                else {
                    handlePrompt(channelId, PREVIEW_PROMPT, channel);
                }
            })().catch(() => { });
            return;
        }
        // Check if waiting for a free-text answer
        const freeText = pendingFreeText.get(channelId);
        if (freeText) {
            clearTimeout(freeText.timer);
            pendingFreeText.delete(channelId);
            // Try to edit the prompt message
            try {
                const promptMsg = await channel.messages.fetch(freeText.msgId);
                await promptMsg.edit(`**${freeText.question}**\n\nAnswer: **${message.content}**`);
            }
            catch { }
            freeText.resolve(message.content);
            return;
        }
        // Strip bot mention from content (e.g. "<@123456> hello" → "hello")
        const cleanContent = botId
            ? message.content.replace(new RegExp(`<@!?${botId}>\\s*`, "g"), "").trim()
            : message.content.trim();
        // Handle attachments (files / images) — also check embeds for images
        // Discord mobile sometimes sends images as embeds (e.g. shared from other apps)
        const embedImageUrls = [];
        if (message.attachments.size === 0 && message.embeds.length > 0) {
            for (const embed of message.embeds) {
                if (embed.image?.url)
                    embedImageUrls.push(embed.image.url);
                if (embed.thumbnail?.url && !embed.image)
                    embedImageUrls.push(embed.thumbnail.url);
            }
        }
        if (message.attachments.size > 0 || embedImageUrls.length > 0) {
            if (router.isProcessing(numericId)) {
                await channel.send("Already processing a request. Use `/cancel` to abort.").catch(() => { });
                return;
            }
            const tmpDir = router.getTempDir();
            fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
            const filePaths = [];
            // Download standard attachments
            for (const [, attachment] of message.attachments) {
                if (attachment.size > MAX_DOWNLOAD_BYTES) {
                    await channel
                        .send(`File too large: ${attachment.name} (${(attachment.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`)
                        .catch(() => { });
                    continue;
                }
                const rawName = attachment.name || `file-${Date.now()}`;
                const fileName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
                const tmpFile = path.join(tmpDir, fileName);
                try {
                    const buf = await downloadDiscordFile(attachment.url, MAX_DOWNLOAD_BYTES);
                    fs.writeFileSync(tmpFile, buf, { mode: 0o600 });
                    filePaths.push(tmpFile);
                }
                catch (err) {
                    await channel.send(`Failed to download ${rawName}: ${err.message}`).catch(() => { });
                }
            }
            // Download images from embeds (e.g. shared from mobile apps)
            for (let i = 0; i < embedImageUrls.length; i++) {
                const url = embedImageUrls[i];
                const ext = url.match(/\.(png|jpe?g|gif|webp)(?:\?|$)/i)?.[1] || "png";
                const fileName = `embed-image-${Date.now()}-${i}.${ext}`;
                const tmpFile = path.join(tmpDir, fileName);
                try {
                    const buf = await downloadDiscordFile(url, MAX_DOWNLOAD_BYTES);
                    fs.writeFileSync(tmpFile, buf, { mode: 0o600 });
                    filePaths.push(tmpFile);
                }
                catch (err) {
                    await channel.send(`Failed to download embedded image: ${err.message}`).catch(() => { });
                }
            }
            if (filePaths.length === 0)
                return;
            const isImage = filePaths.some((fp) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fp));
            const caption = cleanContent || (isImage ? "Describe this image." : `Analyze this file: ${path.basename(filePaths[0])}`);
            const replyCtx = message.reference?.messageId
                ? await (async () => {
                    try {
                        const ref = await channel.messages.fetch(message.reference.messageId);
                        return extractReplyContext(ref);
                    }
                    catch {
                        return "";
                    }
                })()
                : "";
            const fileList = filePaths.map((fp) => fp).join(", ");
            const fileVerb = isImage ? "an image" : "a file";
            const prompt = replyCtx +
                `I've sent you ${filePaths.length > 1 ? `${filePaths.length} files` : fileVerb} saved at ${fileList}\n\n` +
                `Please read ${isImage ? "/view" : ""} ${filePaths.length > 1 ? "those files" : "that file"}, then respond to this: ${caption}`;
            logUser(`[${isImage ? "image" : "document"}: ${filePaths.map((fp) => path.basename(fp)).join(", ")}] ${caption}`, tag);
            handlePrompt(channelId, prompt, channel);
            return;
        }
        // Plain text message
        if (!cleanContent)
            return;
        // ---- Text command fallback (when slash commands are not available) ----
        const textCmd = cleanContent.toLowerCase();
        if (textCmd === "/mode") {
            const current = router.getPermissionMode(numericId);
            const menu = new StringSelectMenuBuilder()
                .setCustomId("mode_select")
                .setPlaceholder("Select a permission mode");
            for (const m of AVAILABLE_PERMISSION_MODES) {
                const check = m.id === current ? " (current)" : "";
                menu.addOptions({ label: `${m.label}${check}`, description: m.description, value: m.id });
            }
            const row = new ActionRowBuilder().addComponents(menu);
            const currentLabel = AVAILABLE_PERMISSION_MODES.find((m) => m.id === current)?.label || current;
            await channel
                .send({
                content: `Current mode: **${currentLabel}**\n\nSelect a permission mode:`,
                components: [row],
            })
                .catch(() => { });
            return;
        }
        if (textCmd === "/new") {
            if (router.isProcessing(numericId)) {
                router.cancelQuery(numericId);
            }
            router.clearSession(numericId);
            await channel.send("Session cleared. Send a message to start fresh.").catch(() => { });
            return;
        }
        if (textCmd === "/cancel") {
            if (router.cancelQuery(numericId)) {
                await channel.send("Operation cancelled.").catch(() => { });
            }
            else {
                await channel.send("Nothing running to cancel.").catch(() => { });
            }
            return;
        }
        if (textCmd === "/model") {
            const current = router.getModel(numericId);
            const menu = new StringSelectMenuBuilder()
                .setCustomId("model_select")
                .setPlaceholder("Select a model");
            for (const m of AVAILABLE_MODELS) {
                const check = m.id === current ? " (current)" : "";
                menu.addOptions({ label: `${m.label}${check}`, value: m.id });
            }
            const row = new ActionRowBuilder().addComponents(menu);
            const currentLabel = AVAILABLE_MODELS.find((m) => m.id === current)?.label || current;
            await channel
                .send({
                content: `Current model: **${currentLabel}**\n\nSelect a model:`,
                components: [row],
            })
                .catch(() => { });
            return;
        }
        if (textCmd === "/cost") {
            const t = router.getSessionTokens(numericId);
            const total = t.inputTokens + t.outputTokens;
            await channel
                .send(`**Session tokens**\n` +
                `Input: ${t.inputTokens.toLocaleString()}\n` +
                `Output: ${t.outputTokens.toLocaleString()}\n` +
                `Cache write: ${t.cacheCreationTokens.toLocaleString()}\n` +
                `Cache read: ${t.cacheReadTokens.toLocaleString()}\n` +
                `Total: ${total.toLocaleString()}`)
                .catch(() => { });
            return;
        }
        if (textCmd === "/help") {
            await channel.send(getHelpText(numericId)).catch(() => { });
            return;
        }
        // ---- Repo text commands ----
        if (textCmd === "/repo" || textCmd.startsWith("/repo ")) {
            if (!isDiscordOwner(userId)) {
                await channel.send("Only the owner can manage repos.").catch(() => { });
                return;
            }
            const args = cleanContent.slice("/repo".length).trim();
            const parts = args.split(/\s+/);
            const subCmd = parts[0]?.toLowerCase();
            if (subCmd === "add") {
                const repoPath = parts[1];
                const alias = parts[2] || undefined;
                if (!repoPath) {
                    await channel.send("Usage: `/repo add <path> [alias]`").catch(() => { });
                    return;
                }
                try {
                    const repoConfig = addRepoToDisk(repoPath, alias);
                    router.addRepo(repoConfig);
                    await channel.send(`Repo added: **${repoConfig.alias}** → \`${repoConfig.path}\``).catch(() => { });
                }
                catch (err) {
                    await channel.send(`Failed: ${err.message}`).catch(() => { });
                }
                return;
            }
            if (subCmd === "list" || !subCmd) {
                const repos = router.listRepos();
                if (repos.length === 0) {
                    await channel.send("No repos. Use `/repo add <path>` to add one.").catch(() => { });
                    return;
                }
                const current = router.getCurrentRepo(numericId);
                const lines = repos.map((r) => {
                    const marker = current && r.path === current.path ? " ← current" : "";
                    return `- **${r.alias}**${marker}\n  \`${r.path}\``;
                });
                await channel.send(`**Repos**\n\n${lines.join("\n")}`).catch(() => { });
                return;
            }
            if (subCmd === "switch") {
                const alias = parts[1];
                if (!alias) {
                    // Show select menu for switching
                    const repos = router.listRepos();
                    if (repos.length === 0) {
                        await channel.send("No repos. Use `/repo add <path>` to add one.").catch(() => { });
                        return;
                    }
                    const current = router.getCurrentRepo(numericId);
                    const menu = new StringSelectMenuBuilder()
                        .setCustomId("repo_switch_select")
                        .setPlaceholder("Select a repo");
                    for (const r of repos) {
                        const check = current && r.path === current.path ? " (current)" : "";
                        menu.addOptions({ label: `${r.alias}${check}`, value: r.path });
                    }
                    const row = new ActionRowBuilder().addComponents(menu);
                    await channel.send({ content: "Select a repo:", components: [row] }).catch(() => { });
                    return;
                }
                const repo = getRepoByAlias(alias);
                if (!repo) {
                    await channel.send(`Repo not found: ${alias}`).catch(() => { });
                    return;
                }
                if (router.isProcessing(numericId)) {
                    await channel.send("Cannot switch while a query is running. Use `/cancel` first.").catch(() => { });
                    return;
                }
                try {
                    router.switchRepo(numericId, repo.path);
                    await channel.send(`Switched to **${repo.alias}** → \`${repo.path}\``).catch(() => { });
                }
                catch (err) {
                    await channel.send(`Failed: ${err.message}`).catch(() => { });
                }
                return;
            }
            if (subCmd === "remove") {
                const alias = parts[1];
                if (!alias) {
                    await channel.send("Usage: `/repo remove <alias>`").catch(() => { });
                    return;
                }
                const repo = getRepoByAlias(alias);
                if (!repo) {
                    await channel.send(`Repo not found: ${alias}`).catch(() => { });
                    return;
                }
                router.removeRepo(repo.path);
                removeRepoFromDisk(alias);
                await channel.send(`Removed repo: **${alias}**`).catch(() => { });
                return;
            }
            await channel.send("**Repo commands:**\n" +
                "`/repo add <path> [alias]` -- Add a repo\n" +
                "`/repo list` -- List all repos\n" +
                "`/repo switch [alias]` -- Switch repo\n" +
                "`/repo remove <alias>` -- Remove a repo").catch(() => { });
            return;
        }
        // ---- Cron text commands ----
        if (textCmd === "/cron" || textCmd.startsWith("/cron ")) {
            const args = cleanContent.slice("/cron".length).trim();
            const parts = args.split(/\s+/);
            const subCmd = parts[0]?.toLowerCase();
            if (subCmd === "add") {
                const input = args.slice("add".length).trim();
                if (!input) {
                    await channel
                        .send("**Schedule a recurring task**\n\n" +
                        "Usage: `/cron add daily 9am run tests`\n" +
                        "Examples:\n" +
                        "- `/cron add every monday write changelog from last week's commits`\n" +
                        "- `/cron add every 6 hours check for new dependency vulnerabilities`")
                        .catch(() => { });
                    return;
                }
                await channel.send("Parsing schedule...").catch(() => { });
                const parsed = await parseScheduleWithClaude(input);
                if (!parsed) {
                    await channel
                        .send("Could not parse schedule. Try being more specific, e.g. `/cron add daily 9am run tests`")
                        .catch(() => { });
                    return;
                }
                const schedTimer = setTimeout(() => {
                    pendingScheduleConfirm.delete(channelId);
                    channel.send("Schedule confirmation timed out. Send `/cron add` to try again.").catch(() => { });
                }, SCHEDULE_CONFIRM_TIMEOUT_MS);
                pendingScheduleConfirm.set(channelId, {
                    schedule: {
                        botId: snowflakeToNumeric(botConfig.id),
                        chatId: numericId,
                        prompt: parsed.prompt,
                        cronExpr: parsed.cronExpr,
                        humanLabel: parsed.humanLabel,
                        platform: "discord",
                        channelId,
                        ...(parsed.once && { once: true }),
                    },
                    timer: schedTimer,
                });
                const confirmRow = new ActionRowBuilder().addComponents(new ButtonBuilder()
                    .setCustomId(`cron:confirm:${channelId}`)
                    .setLabel("Confirm")
                    .setStyle(ButtonStyle.Primary), new ButtonBuilder()
                    .setCustomId(`cron:cancel:${channelId}`)
                    .setLabel("Cancel")
                    .setStyle(ButtonStyle.Secondary));
                await channel
                    .send({
                    content: "**Confirm schedule**\n\n" +
                        `**When:** ${parsed.humanLabel}${parsed.once ? " (one-time)" : ""}\n` +
                        `**Task:** ${parsed.prompt}\n\n` +
                        "_Scheduled tasks run automatically without approval prompts._",
                    components: [confirmRow],
                })
                    .catch(() => { });
                return;
            }
            if (subCmd === "list") {
                const botNumericId = snowflakeToNumeric(botConfig.id);
                const schedules = scheduleManager.getForBot(botNumericId);
                if (schedules.length === 0) {
                    await channel.send("No scheduled tasks. Use `/cron add` to add one.").catch(() => { });
                    return;
                }
                const lines = schedules.map((s, i) => {
                    const lastRun = s.lastRunAt
                        ? `Last run: ${new Date(s.lastRunAt).toLocaleString()}`
                        : "Never run";
                    return `**[${i + 1}]** ${s.humanLabel}\n${s.prompt}\n_${lastRun}_`;
                });
                await channel
                    .send(`**Scheduled tasks for ${getRepoName(numericId)}**\n\n` +
                    lines.join("\n\n") +
                    "\n\nUse `/cron del <number>` to remove.")
                    .catch(() => { });
                return;
            }
            if (subCmd === "del") {
                const arg = parts[1];
                if (!arg) {
                    await channel
                        .send("Usage: `/cron del <number>`\n\nUse `/cron list` to see the list.")
                        .catch(() => { });
                    return;
                }
                const botNumericId = snowflakeToNumeric(botConfig.id);
                const allSchedules = scheduleManager.getForBot(botNumericId);
                const idx = parseInt(arg, 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= allSchedules.length) {
                    await channel.send("Invalid number. Use `/cron list` to see the list.").catch(() => { });
                    return;
                }
                const sched = allSchedules[idx];
                scheduleManager.remove(sched.id);
                await channel.send(`Removed: **${sched.humanLabel}**`).catch(() => { });
                return;
            }
            // 無效子命令或無參數 — 顯示用法
            await channel
                .send("**Scheduled Tasks**\n\n" +
                "`/cron add [task]` — Schedule a recurring task\n" +
                "`/cron list` — List scheduled tasks\n" +
                "`/cron del [number]` — Remove a scheduled task")
                .catch(() => { });
            return;
        }
        let replyCtx = "";
        if (message.reference?.messageId) {
            try {
                const ref = await channel.messages.fetch(message.reference.messageId);
                replyCtx = extractReplyContext(ref);
            }
            catch { }
        }
        const prompt = replyCtx + cleanContent;
        logUser(cleanContent, tag);
        handlePrompt(channelId, prompt, channel);
    });
    // ---- Error handler ----
    client.on("error", (err) => {
        console.error(`[${tag}] Discord client error:`, err.message);
    });
    return client;
}
