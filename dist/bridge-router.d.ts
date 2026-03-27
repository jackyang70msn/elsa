import { ClaudeBridge } from "./claude.js";
import type { SendCallbacks, TokenUsage, PermissionMode } from "./claude.js";
import type { RepoConfig } from "./repo-manager.js";
/**
 * BridgeRouter — routes chatId to the correct ClaudeBridge based on the
 * user's currently selected repo. Proxies all ClaudeBridge methods so
 * that workers can use it as a drop-in replacement.
 */
export declare class BridgeRouter {
    private readonly botId;
    private readonly botUsername;
    /** repoPath → ClaudeBridge */
    private bridges;
    /** repoPath → RepoConfig */
    private repos;
    /** chatId → repoPath (current selection) */
    private currentRepo;
    constructor(botId: number, botUsername: string);
    addRepo(repoConfig: RepoConfig): ClaudeBridge;
    removeRepo(repoPath: string): void;
    listRepos(): RepoConfig[];
    switchRepo(chatId: number, repoPath: string): void;
    getCurrentRepo(chatId: number): RepoConfig | undefined;
    getBridge(chatId: number): ClaudeBridge | undefined;
    /** Get bridge, throwing if no repo is selected */
    private requireBridge;
    sendMessage(chatId: number, prompt: string, callbacks: SendCallbacks, permissionMode?: PermissionMode, maxTurns?: number): Promise<void>;
    cancelQuery(chatId: number): boolean;
    isProcessing(chatId: number): boolean;
    isCoolingDown(chatId: number): boolean;
    getSessionId(chatId: number): string | undefined;
    setSessionId(chatId: number, sessionId: string): void;
    clearSession(chatId: number): void;
    getModel(chatId: number): string;
    setModel(chatId: number, modelId: string): void;
    getSessionTokens(chatId: number): TokenUsage;
    getPermissionMode(chatId: number): PermissionMode;
    setPermissionMode(chatId: number, mode: PermissionMode): void;
    allowUser(chatId: number, userId: number): void;
    denyUser(chatId: number, userId: number): boolean;
    isAllowedUser(chatId: number, userId: number): boolean;
    getAllowedUsers(chatId: number): number[];
    setLastPrompt(chatId: number, prompt: string): void;
    getLastPrompt(chatId: number): string | undefined;
    getProjectSessionsDir(chatId?: number): string;
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
    getTempDir(): string;
    cleanupTempFiles(): void;
    abortAll(): void;
}
