/**
 * Discord Markdown formatter for Elsa.
 *
 * Claude outputs standard Markdown.  Discord supports most of it natively,
 * so the conversion is intentionally lightweight compared to the Telegram
 * HTML formatter in formatter.ts.
 */
export declare function claudeToDiscord(markdown: string): string;
export declare function splitDiscordMessage(text: string, maxLen?: number): string[];
export declare function formatToolCallDiscord(toolName: string, input: Record<string, unknown>): string;
