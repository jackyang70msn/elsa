import {
  Client, GatewayIntentBits, Partials, ChannelType,
  SlashCommandBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
} from "discord.js";
import fs from "node:fs";
import { isDiscordOwner } from "./config.js";
import type { DiscordBotConfig } from "./store.js";
import { loadSchedules } from "./scheduler.js";

export interface DiscordManagerCallbacks {
  startWorker: (botConfig: DiscordBotConfig) => Promise<void>;
  stopWorker: (botId: string) => Promise<void>;
  getActiveWorkers: () => Map<string, { config: DiscordBotConfig }>;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_~`|\\])/g, "\\$1");
}

export function createDiscordManager(
  token: string,
  guildId: string,
  callbacks: DiscordManagerCallbacks,
): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  // --- Slash command definitions ---

  const botsCommand = new SlashCommandBuilder()
    .setName("bots")
    .setDescription("List all active worker bots");

  const addCommand = new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add a new worker bot");

  const removeCommand = new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a worker bot")
    .addStringOption((opt) =>
      opt
        .setName("bot")
        .setDescription("Bot username to remove, or \"all\" to remove all")
        .setRequired(true),
    );

  const schedulesCommand = new SlashCommandBuilder()
    .setName("schedules")
    .setDescription("View all scheduled tasks across bots");

  const helpCommand = new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show help message");

  const cancelCommand = new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel current operation");

  const commands = [
    botsCommand,
    addCommand,
    removeCommand,
    schedulesCommand,
    helpCommand,
    cancelCommand,
  ];

  // --- Register commands on ready ---

  client.once("clientReady", async () => {
    try {
      if (!client.application) {
        console.error("[discord-manager] No application object available");
        return;
      }
      // Always register global commands (so DMs work)
      await client.application.commands.set(commands.map((c) => c.toJSON()));
      console.log(`[discord-manager] Registered ${commands.length} global slash commands`);

      if (guildId) {
        // Also register guild-specific for instant availability in server
        await client.application.commands.set(commands.map((c) => c.toJSON()), guildId);
        console.log(`[discord-manager] Registered ${commands.length} guild slash commands for ${guildId}`);
      }
    } catch (err) {
      console.error("[discord-manager] Failed to register slash commands:", (err as Error).message);
    }
  });

  // --- Interaction handler ---

  client.on("interactionCreate", async (interaction) => {
    try {
      // Handle modal submissions
      if (interaction.isModalSubmit()) {
        if (interaction.customId === "add_bot_modal") {
          await handleAddModal(interaction);
        }
        return;
      }

      // Handle slash commands
      if (!interaction.isChatInputCommand()) return;

      // Auth check
      if (!isDiscordOwner(interaction.user.id)) {
        await interaction.reply({ content: "Unauthorized.", ephemeral: true }).catch(() => {});
        return;
      }

      switch (interaction.commandName) {
        case "bots":
          await handleBots(interaction);
          break;
        case "add":
          await handleAdd(interaction);
          break;
        case "remove":
          await handleRemove(interaction);
          break;
        case "schedules":
          await handleSchedules(interaction);
          break;
        case "help":
          await handleHelp(interaction);
          break;
        case "cancel":
          await handleCancel(interaction);
          break;
      }
    } catch (err) {
      console.error("[discord-manager] Interaction error:", (err as Error).message);
    }
  });

  // --- Command handlers ---

  async function handleBots(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    const workers = callbacks.getActiveWorkers();
    if (workers.size === 0) {
      await interaction.reply({ content: "No worker bots active.", ephemeral: true }).catch(() => {});
      return;
    }

    const lines: string[] = [];
    for (const [, w] of workers) {
      lines.push(`- **@${escapeMarkdown(w.config.username)}** — \`${w.config.workingDir}\``);
    }

    await interaction.reply({
      content: `**Active bots (${workers.size}):**\n${lines.join("\n")}`,
      ephemeral: true,
    }).catch(() => {});
  }

  async function handleAdd(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    // Auth check (modal submission is checked separately)
    if (!isDiscordOwner(interaction.user.id)) {
      await interaction.reply({ content: "Unauthorized.", ephemeral: true }).catch(() => {});
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId("add_bot_modal")
      .setTitle("Add Worker Bot");

    const tokenInput = new TextInputBuilder()
      .setCustomId("bot_token")
      .setLabel("Bot Token (from Discord Developer Portal)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("MTIzNDU2Nzg5...")
      .setRequired(true);

    const pathInput = new TextInputBuilder()
      .setCustomId("repo_path")
      .setLabel("Repository Path")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("C:\\path\\to\\project")
      .setRequired(true);

    const tokenRow = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(tokenInput);
    const pathRow = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(pathInput);

    modal.addComponents(tokenRow, pathRow);

    await interaction.showModal(modal).catch(() => {});
  }

  async function handleAddModal(interaction: import("discord.js").ModalSubmitInteraction): Promise<void> {
    // Auth check for modal submitter
    if (!isDiscordOwner(interaction.user.id)) {
      await interaction.reply({ content: "Unauthorized.", ephemeral: true }).catch(() => {});
      return;
    }

    const botToken = interaction.fields.getTextInputValue("bot_token").trim();
    const repoPath = interaction.fields.getTextInputValue("repo_path").trim();

    // Validate path exists
    if (!fs.existsSync(repoPath)) {
      await interaction.reply({
        content: `Path does not exist: \`${repoPath}\``,
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    if (!fs.statSync(repoPath).isDirectory()) {
      await interaction.reply({
        content: `Path is not a directory: \`${repoPath}\``,
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    // Defer reply since token validation might take > 3 seconds
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    // Validate token by creating a temporary client
    let botInfo: { id: string; username: string };
    try {
      const tempClient = new Client({ intents: [] });
      await tempClient.login(botToken);

      // Wait for ready event to get user info
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          tempClient.destroy().catch(() => {});
          reject(new Error("Login timed out"));
        }, 15_000);

        tempClient.once("clientReady", () => {
          clearTimeout(timeout);
          resolve();
        });
        tempClient.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const user = tempClient.user;
      if (!user) {
        await tempClient.destroy().catch(() => {});
        throw new Error("Could not retrieve bot user info");
      }

      botInfo = { id: user.id, username: user.username };
      await tempClient.destroy().catch(() => {});
    } catch (err) {
      console.error("[discord-manager] Token validation failed:", (err as Error).message);
      await interaction.editReply({
        content: "Invalid bot token. Check it and try again.",
      }).catch(() => {});
      return;
    }

    // Check for duplicate
    const workers = callbacks.getActiveWorkers();
    if (workers.has(botInfo.id)) {
      await interaction.editReply({
        content: `Bot @${botInfo.username} is already active. Remove it first with \`/remove bot:${botInfo.username}\``,
      }).catch(() => {});
      return;
    }

    const botConfig: DiscordBotConfig = {
      id: botInfo.id,
      token: botToken,
      username: botInfo.username,
      guildId,
      workingDir: repoPath,
    };

    try {
      await callbacks.startWorker(botConfig);
      await interaction.editReply({
        content:
          `Added **@${escapeMarkdown(botInfo.username)}**\n` +
          `Repo: \`${repoPath}\`\n\n` +
          `Message @${escapeMarkdown(botInfo.username)} to start working!`,
      }).catch(() => {});
    } catch (err) {
      console.error("[discord-manager] Worker start failed:", (err as Error).message);
      await interaction.editReply({
        content: "Failed to start worker. Check logs for details.",
      }).catch(() => {});
    }
  }

  async function handleRemove(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    const arg = interaction.options.getString("bot", true).trim().replace(/^@/, "");

    if (arg === "all") {
      const workers = callbacks.getActiveWorkers();
      if (workers.size === 0) {
        await interaction.reply({ content: "No active workers to remove.", ephemeral: true }).catch(() => {});
        return;
      }

      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      const ids = [...workers.keys()];
      const usernames = [...workers.values()].map((w) => `@${w.config.username}`);
      const errors: string[] = [];

      for (const id of ids) {
        try {
          await callbacks.stopWorker(id);
        } catch (err) {
          errors.push(String(err));
        }
      }

      if (errors.length === 0) {
        await interaction.editReply({
          content: `Removed all workers: ${usernames.join(", ")}`,
        }).catch(() => {});
      } else {
        await interaction.editReply({
          content: `Removed workers with errors:\n${errors.join("\n")}`,
        }).catch(() => {});
      }
      return;
    }

    const workers = callbacks.getActiveWorkers();
    let foundId: string | null = null;
    for (const [id, w] of workers) {
      if (w.config.username === arg) {
        foundId = id;
        break;
      }
    }

    if (foundId === null) {
      await interaction.reply({
        content: `Bot @${arg} not found in active workers.`,
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    try {
      await callbacks.stopWorker(foundId);
      await interaction.reply({
        content: `Removed @${arg}. Bot stopped.`,
        ephemeral: true,
      }).catch(() => {});
    } catch (err) {
      console.error(`[discord-manager] Remove @${arg} failed:`, (err as Error).message);
      await interaction.reply({
        content: `Error removing @${arg}. Check logs for details.`,
        ephemeral: true,
      }).catch(() => {});
    }
  }

  async function handleSchedules(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    const allSchedules = loadSchedules();
    const workers = callbacks.getActiveWorkers();

    if (allSchedules.length === 0) {
      await interaction.reply({ content: "No scheduled tasks across any bots.", ephemeral: true }).catch(() => {});
      return;
    }

    const lines: string[] = [];
    for (const [, w] of workers) {
      // Schedule botId is number (Telegram), so we compare with string id via toString
      const botSchedules = allSchedules.filter((s) => String(s.botId) === w.config.id);
      if (botSchedules.length === 0) continue;
      lines.push(`**@${escapeMarkdown(w.config.username)}** (${botSchedules.length})`);
      for (const s of botSchedules) {
        lines.push(`  - ${escapeMarkdown(s.humanLabel)} — ${escapeMarkdown(s.prompt)}`);
      }
    }

    if (lines.length === 0) {
      await interaction.reply({ content: "No scheduled tasks for active Discord bots.", ephemeral: true }).catch(() => {});
      return;
    }

    await interaction.reply({
      content: lines.join("\n"),
      ephemeral: true,
    }).catch(() => {});
  }

  async function handleHelp(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    const helpText =
      "**Claude Multi-Bot Manager (Discord)**\n\n" +
      "**Commands:**\n" +
      "/bots — List all active worker bots\n" +
      "/add — Add a new worker bot\n" +
      "/remove — Remove a worker bot\n" +
      "/schedules — View all scheduled tasks\n" +
      "/help — Show this help message";

    await interaction.reply({ content: helpText, ephemeral: true }).catch(() => {});
  }

  async function handleCancel(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: "Nothing to cancel.", ephemeral: true }).catch(() => {});
  }

  return client;
}
