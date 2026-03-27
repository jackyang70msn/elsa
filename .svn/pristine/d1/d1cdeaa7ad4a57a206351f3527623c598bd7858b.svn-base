import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import "dotenv/config";

export const DATA_DIR = path.join(os.homedir(), ".elsa");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

interface SavedConfig {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_ID?: number | number[];
  NGROK_AUTH_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_OWNER_ID?: string | number | (string | number)[];
}

function loadSavedConfig(): SavedConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function required(name: string, savedValue?: string | number): string {
  const value = process.env[name] ?? (savedValue !== undefined ? String(savedValue) : undefined);
  if (!value) {
    console.error(`Missing required config: ${name}`);
    console.error("Run: elsa setup");
    process.exit(1);
  }
  return value;
}

function parseOwnerIds(envValue: string | undefined, savedValue: number | number[] | undefined): number[] {
  if (envValue) {
    return envValue.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
  }
  if (Array.isArray(savedValue)) return savedValue;
  if (typeof savedValue === "number") return [savedValue];
  return [];
}

function parseDiscordOwnerIds(envValue: string | undefined, savedValue: string | number | (string | number)[] | undefined): string[] {
  if (envValue) return envValue.split(",").map(s => s.trim()).filter(s => s.length > 0);
  if (Array.isArray(savedValue)) return savedValue.map(v => String(v));
  if (savedValue !== undefined) return [String(savedValue)];
  return [];
}

const saved = loadSavedConfig();

const ownerIds = parseOwnerIds(process.env.TELEGRAM_OWNER_ID, saved.TELEGRAM_OWNER_ID);

function optional(name: string, savedValue?: string | number): string | undefined {
  return process.env[name] ?? (savedValue !== undefined ? String(savedValue) : undefined);
}

export const config = {
  TELEGRAM_BOT_TOKEN: optional("TELEGRAM_BOT_TOKEN", saved.TELEGRAM_BOT_TOKEN),
  TELEGRAM_OWNER_IDS: ownerIds,
  NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN ?? saved.NGROK_AUTH_TOKEN ?? undefined,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ?? saved.DISCORD_BOT_TOKEN ?? undefined,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID ?? saved.DISCORD_GUILD_ID ?? undefined,
  DISCORD_OWNER_IDS: parseDiscordOwnerIds(process.env.DISCORD_OWNER_ID, saved.DISCORD_OWNER_ID),
  DATA_DIR,
};

export function isOwner(userId: number | undefined): boolean {
  return userId !== undefined && config.TELEGRAM_OWNER_IDS.includes(userId);
}

export function isDiscordOwner(userId: string | undefined): boolean {
  return userId !== undefined && config.DISCORD_OWNER_IDS.includes(userId);
}
