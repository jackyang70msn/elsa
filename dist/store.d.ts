export interface BotConfig {
    id: number;
    token: string;
    username: string;
    workingDir: string;
}
export declare function loadBots(): BotConfig[];
export declare function saveBots(bots: BotConfig[]): void;
export declare function addBot(bot: BotConfig): void;
export declare function removeBot(botId: number): void;
export declare function getBots(): BotConfig[];
/**
 * Convert a Discord snowflake (string, ~18 digits) to a number that
 * fits inside JS safe integer range for ClaudeBridge compatibility.
 */
export declare function snowflakeToNumeric(snowflake: string): number;
/** Resolve full path to `claude` CLI binary, caching the result. */
export declare function resolveClaudePath(): string;
export interface DiscordBotConfig {
    id: string;
    token: string;
    username: string;
    guildId: string;
    workingDir: string;
}
export declare function loadDiscordBots(): DiscordBotConfig[];
export declare function saveDiscordBots(bots: DiscordBotConfig[]): void;
export declare function addDiscordBot(bot: DiscordBotConfig): void;
export declare function removeDiscordBot(botId: string): void;
