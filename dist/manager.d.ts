import { Bot } from "grammy";
import type { BotConfig } from "./store.js";
export interface ManagerCallbacks {
    startWorker: (botConfig: BotConfig) => Promise<void>;
    stopWorker: (botId: number) => Promise<void>;
    getActiveWorkers: () => Map<number, {
        config: BotConfig;
    }>;
}
export declare function createManager(callbacks: ManagerCallbacks): Bot;
