export type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan";
export declare const AVAILABLE_PERMISSION_MODES: readonly [{
    readonly id: "bypassPermissions";
    readonly label: "Bypass";
    readonly description: "Auto-approve all operations";
}, {
    readonly id: "acceptEdits";
    readonly label: "Accept Edits";
    readonly description: "Auto-approve file edits, deny Bash";
}, {
    readonly id: "plan";
    readonly label: "Plan Only";
    readonly description: "Read-only analysis, no modifications";
}];
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}
export interface AskUserQuestion {
    question: string;
    header: string;
    options: Array<{
        label: string;
        description: string;
    }>;
    multiSelect: boolean;
}
export interface SendCallbacks {
    onStreamChunk: (text: string) => void;
    onStatusUpdate: (status: string) => void;
    onToolApproval: (toolName: string, input: Record<string, unknown>) => Promise<"allow" | "always" | "deny">;
    onAskUser: (questions: AskUserQuestion[]) => Promise<Record<string, string>>;
    onPlanApproval: (planFileContent?: string) => Promise<boolean>;
    onResult: (result: {
        text: string;
        usage: TokenUsage;
        turns: number;
        durationMs: number;
    }) => void;
    onError: (error: Error) => void;
    onSessionReset?: () => void;
}
export declare const AVAILABLE_MODELS: readonly [{
    readonly id: "claude-opus-4-6";
    readonly label: "Opus 4.6";
}, {
    readonly id: "claude-sonnet-4-6";
    readonly label: "Sonnet 4.6";
}, {
    readonly id: "claude-haiku-4-5-20251001";
    readonly label: "Haiku 4.5";
}];
export declare class ClaudeBridge {
    readonly workingDir: string;
    readonly botId: number;
    private readonly tag;
    private readonly stateFile;
    private sessions;
    private sessionTokens;
    private activeAborts;
    private selectedModels;
    private lastQueryEnd;
    private lastPrompts;
    private allowedUsers;
    private permissionModes;
    private cleanupTimers;
    private readonly cleanEnv;
    constructor(botId: number, workingDir: string, tag: string, stateDir?: string);
    private loadState;
    private saveState;
    isProcessing(chatId: number): boolean;
    getSessionTokens(chatId: number): TokenUsage;
    clearSession(chatId: number): void;
    setModel(chatId: number, modelId: string): void;
    getModel(chatId: number): string;
    getSessionId(chatId: number): string | undefined;
    setSessionId(chatId: number, sessionId: string): void;
    getProjectSessionsDir(): string;
    listRecentSessions(limit?: number): Array<{
        sessionId: string;
        modifiedAt: Date;
        promptPreview: string;
    }>;
    getSessionHistory(sessionId: string, limit?: number): Array<{
        role: "user" | "assistant";
        text: string;
        timestamp: string;
    }>;
    cancelQuery(chatId: number): boolean;
    isCoolingDown(chatId: number): boolean;
    setLastPrompt(chatId: number, prompt: string): void;
    getLastPrompt(chatId: number): string | undefined;
    isAllowedUser(chatId: number, userId: number): boolean;
    allowUser(chatId: number, userId: number): void;
    denyUser(chatId: number, userId: number): boolean;
    getAllowedUsers(chatId: number): number[];
    setPermissionMode(chatId: number, mode: PermissionMode): void;
    getPermissionMode(chatId: number): PermissionMode;
    abortAll(): void;
    shutdown(): void;
    getTempDir(): string;
    cleanupTempFiles(): void;
    private spawnClaude;
    private stderrBuffer;
    private parseCliStream;
    sendMessage(chatId: number, prompt: string, callbacks: SendCallbacks, permissionMode?: PermissionMode, maxTurns?: number): Promise<void>;
}
