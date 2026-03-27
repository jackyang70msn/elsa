export declare function escapeHtml(text: string): string;
export declare function claudeToTelegram(markdown: string): string;
export declare function splitMessage(text: string, limit?: number): string[];
export declare function formatToolCall(toolName: string, input: Record<string, unknown>): string;
