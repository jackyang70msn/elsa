import { Bot } from "grammy";
import { BridgeRouter } from "./bridge-router.js";
import type { BotConfig } from "./store.js";
import { TunnelManager } from "./tunnel.js";
import { ScheduleManager } from "./scheduler.js";
export declare function createWorker(botConfig: BotConfig, router: BridgeRouter, tunnelManager: TunnelManager, scheduleManager: ScheduleManager): Bot;
