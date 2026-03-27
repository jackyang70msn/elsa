import "dotenv/config";
export declare const DATA_DIR: string;
export declare const config: {
    TELEGRAM_BOT_TOKEN: string | undefined;
    TELEGRAM_OWNER_IDS: number[];
    NGROK_AUTH_TOKEN: string | undefined;
    DISCORD_BOT_TOKEN: string | undefined;
    DISCORD_GUILD_ID: string | undefined;
    DISCORD_OWNER_IDS: string[];
    DATA_DIR: string;
};
export declare function isOwner(userId: number | undefined): boolean;
export declare function isDiscordOwner(userId: string | undefined): boolean;
