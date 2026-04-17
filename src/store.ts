import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.js";

export interface BotConfig {
  id: number;
  token: string;
  username: string;
  workingDir: string;
}

const BOTS_FILE = path.join(config.DATA_DIR, "bots.json");

function ensureDataDir(): void {
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadBots(): BotConfig[] {
  try {
    if (!fs.existsSync(BOTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(BOTS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveBots(bots: BotConfig[]): void {
  ensureDataDir();
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2), { mode: 0o600 });
}

export function addBot(bot: BotConfig): void {
  const bots = loadBots().filter((b) => b.id !== bot.id);
  bots.push(bot);
  saveBots(bots);
}

export function removeBot(botId: number): void {
  const bots = loadBots().filter((b) => b.id !== botId);
  saveBots(bots);
}

export function getBots(): BotConfig[] {
  return loadBots();
}

/**
 * Convert a Discord snowflake (string, ~18 digits) to a number that
 * fits inside JS safe integer range for ClaudeBridge compatibility.
 */
export function snowflakeToNumeric(snowflake: string): number {
  return Number(BigInt(snowflake) % BigInt(Number.MAX_SAFE_INTEGER));
}

// --- Claude CLI path resolution ---

export interface ClaudeLaunch {
  /** Executable to spawn. */
  command: string;
  /** Args to prepend before caller-supplied arguments. */
  prependArgs: string[];
}

let _claudePath: ClaudeLaunch | null = null;

/**
 * Resolve how to launch the `claude` CLI for `child_process.spawn`.
 *
 * On Windows, Node (>=18.20 / 20.12 / 21.7, CVE-2024-27980) refuses to spawn
 * `.cmd`/`.bat` files directly — it throws `EINVAL`. We therefore prefer a
 * `.exe` when available, otherwise fall back to invoking the underlying
 * `cli.js` through the current Node binary.
 */
export function resolveClaudePath(): ClaudeLaunch {
  if (_claudePath) return _claudePath;

  if (process.platform === "win32") {
    try {
      const result = execFileSync("where.exe", ["claude"], { encoding: "utf8", timeout: 5000 });
      const lines = result.trim().split(/\r?\n/).filter(Boolean);
      const exeLine = lines.find((l) => l.toLowerCase().endsWith(".exe"));
      if (exeLine) {
        _claudePath = { command: exeLine, prependArgs: [] };
        return _claudePath;
      }
      // No .exe — locate the real cli.js near the shim and invoke via node.
      const shim = lines.find((l) => l.toLowerCase().endsWith(".cmd")) || lines[0];
      if (shim) {
        const dir = path.dirname(shim);
        const cliJs = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
        if (fs.existsSync(cliJs)) {
          _claudePath = { command: process.execPath, prependArgs: [cliJs] };
          return _claudePath;
        }
      }
    } catch {}
  } else {
    try {
      const result = execFileSync("which", ["claude"], { encoding: "utf8", timeout: 5000 });
      const firstLine = result.trim().split(/\r?\n/)[0];
      if (firstLine) {
        _claudePath = { command: firstLine, prependArgs: [] };
        return _claudePath;
      }
    } catch {}
  }

  _claudePath = { command: "claude", prependArgs: [] };
  return _claudePath;
}

// --- Discord bot storage ---

export interface DiscordBotConfig {
  id: string;
  token: string;
  username: string;
  guildId: string;
  workingDir: string;
}

const DISCORD_BOTS_FILE = path.join(config.DATA_DIR, "discord-bots.json");

export function loadDiscordBots(): DiscordBotConfig[] {
  try {
    if (!fs.existsSync(DISCORD_BOTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(DISCORD_BOTS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveDiscordBots(bots: DiscordBotConfig[]): void {
  ensureDataDir();
  fs.writeFileSync(DISCORD_BOTS_FILE, JSON.stringify(bots, null, 2), { mode: 0o600 });
}

export function addDiscordBot(bot: DiscordBotConfig): void {
  const bots = loadDiscordBots().filter((b) => b.id !== bot.id);
  bots.push(bot);
  saveDiscordBots(bots);
}

export function removeDiscordBot(botId: string): void {
  const bots = loadDiscordBots().filter((b) => b.id !== botId);
  saveDiscordBots(bots);
}

