import { Client } from "discord.js";
import type { DiscordBotConfig } from "./store.js";
export interface DiscordManagerCallbacks {
    startWorker: (botConfig: DiscordBotConfig) => Promise<void>;
    stopWorker: (botId: string) => Promise<void>;
    getActiveWorkers: () => Map<string, {
        config: DiscordBotConfig;
    }>;
}
export declare function createDiscordManager(token: string, guildId: string, callbacks: DiscordManagerCallbacks): Client;
