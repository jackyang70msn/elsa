import { Client } from "discord.js";
import { type DiscordBotConfig } from "./store.js";
import { BridgeRouter } from "./bridge-router.js";
import { TunnelManager } from "./tunnel.js";
import { ScheduleManager } from "./scheduler.js";
export declare function createDiscordWorker(botConfig: DiscordBotConfig, router: BridgeRouter, tunnelManager: TunnelManager, scheduleManager: ScheduleManager): Client;
