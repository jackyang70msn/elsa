import { ClaudeBridge } from "./claude.js";
import { getRepoStateDir } from "./repo-manager.js";
/**
 * BridgeRouter — routes chatId to the correct ClaudeBridge based on the
 * user's currently selected repo. Proxies all ClaudeBridge methods so
 * that workers can use it as a drop-in replacement.
 */
export class BridgeRouter {
    botId;
    botUsername;
    /** repoPath → ClaudeBridge */
    bridges = new Map();
    /** repoPath → RepoConfig */
    repos = new Map();
    /** chatId → repoPath (current selection) */
    currentRepo = new Map();
    constructor(botId, botUsername) {
        this.botId = botId;
        this.botUsername = botUsername;
    }
    // ---- Repo management ----
    addRepo(repoConfig) {
        const stateDir = getRepoStateDir(repoConfig.path);
        const bridge = new ClaudeBridge(this.botId, repoConfig.path, this.botUsername, stateDir);
        this.bridges.set(repoConfig.path, bridge);
        this.repos.set(repoConfig.path, repoConfig);
        return bridge;
    }
    removeRepo(repoPath) {
        const bridge = this.bridges.get(repoPath);
        if (bridge) {
            bridge.abortAll();
        }
        this.bridges.delete(repoPath);
        this.repos.delete(repoPath);
        // Unset current repo for any chat pointing to this repo
        for (const [chatId, path] of this.currentRepo) {
            if (path === repoPath) {
                this.currentRepo.delete(chatId);
            }
        }
    }
    listRepos() {
        return [...this.repos.values()];
    }
    // ---- Chat → Repo routing ----
    switchRepo(chatId, repoPath) {
        if (!this.bridges.has(repoPath)) {
            throw new Error(`Repo not found: ${repoPath}`);
        }
        this.currentRepo.set(chatId, repoPath);
    }
    getCurrentRepo(chatId) {
        const repoPath = this.currentRepo.get(chatId);
        if (!repoPath) {
            // Auto-select first repo if available
            const first = this.repos.values().next().value;
            if (first) {
                this.currentRepo.set(chatId, first.path);
                return first;
            }
            return undefined;
        }
        return this.repos.get(repoPath);
    }
    getBridge(chatId) {
        const repo = this.getCurrentRepo(chatId);
        if (!repo)
            return undefined;
        return this.bridges.get(repo.path);
    }
    /** Get bridge, throwing if no repo is selected */
    requireBridge(chatId) {
        const bridge = this.getBridge(chatId);
        if (!bridge)
            throw new Error("No repo selected. Use /repo add to add one.");
        return bridge;
    }
    // ---- Proxied ClaudeBridge methods ----
    async sendMessage(chatId, prompt, callbacks, permissionMode, maxTurns) {
        return this.requireBridge(chatId).sendMessage(chatId, prompt, callbacks, permissionMode, maxTurns);
    }
    cancelQuery(chatId) {
        const bridge = this.getBridge(chatId);
        return bridge ? bridge.cancelQuery(chatId) : false;
    }
    isProcessing(chatId) {
        const bridge = this.getBridge(chatId);
        return bridge ? bridge.isProcessing(chatId) : false;
    }
    isCoolingDown(chatId) {
        const bridge = this.getBridge(chatId);
        return bridge ? bridge.isCoolingDown(chatId) : false;
    }
    getSessionId(chatId) {
        const bridge = this.getBridge(chatId);
        return bridge?.getSessionId(chatId);
    }
    setSessionId(chatId, sessionId) {
        this.requireBridge(chatId).setSessionId(chatId, sessionId);
    }
    clearSession(chatId) {
        const bridge = this.getBridge(chatId);
        bridge?.clearSession(chatId);
    }
    getModel(chatId) {
        return this.requireBridge(chatId).getModel(chatId);
    }
    setModel(chatId, modelId) {
        this.requireBridge(chatId).setModel(chatId, modelId);
    }
    getSessionTokens(chatId) {
        const bridge = this.getBridge(chatId);
        return bridge?.getSessionTokens(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    }
    getPermissionMode(chatId) {
        return this.requireBridge(chatId).getPermissionMode(chatId);
    }
    setPermissionMode(chatId, mode) {
        this.requireBridge(chatId).setPermissionMode(chatId, mode);
    }
    allowUser(chatId, userId) {
        this.requireBridge(chatId).allowUser(chatId, userId);
    }
    denyUser(chatId, userId) {
        const bridge = this.getBridge(chatId);
        return bridge ? bridge.denyUser(chatId, userId) : false;
    }
    isAllowedUser(chatId, userId) {
        const bridge = this.getBridge(chatId);
        return bridge ? bridge.isAllowedUser(chatId, userId) : false;
    }
    getAllowedUsers(chatId) {
        const bridge = this.getBridge(chatId);
        return bridge?.getAllowedUsers(chatId) || [];
    }
    setLastPrompt(chatId, prompt) {
        const bridge = this.getBridge(chatId);
        bridge?.setLastPrompt(chatId, prompt);
    }
    getLastPrompt(chatId) {
        const bridge = this.getBridge(chatId);
        return bridge?.getLastPrompt(chatId);
    }
    getProjectSessionsDir(chatId) {
        // Get sessions dir from the current repo's bridge
        let bridge;
        if (chatId !== undefined) {
            bridge = this.getBridge(chatId);
        }
        else {
            // Fallback: use first bridge if no chatId provided
            bridge = this.bridges.values().next().value;
        }
        return bridge?.getProjectSessionsDir() || "";
    }
    listRecentSessions(limit) {
        // List sessions from the current bridge (if any)
        const firstBridge = this.bridges.values().next().value;
        return firstBridge?.listRecentSessions(limit) || [];
    }
    getSessionHistory(sessionId, limit) {
        const firstBridge = this.bridges.values().next().value;
        return firstBridge?.getSessionHistory(sessionId, limit) || [];
    }
    getTempDir() {
        const firstBridge = this.bridges.values().next().value;
        return firstBridge?.getTempDir() || "";
    }
    cleanupTempFiles() {
        // Clean up for all bridges
        for (const bridge of this.bridges.values()) {
            bridge.cleanupTempFiles();
        }
    }
    abortAll() {
        for (const bridge of this.bridges.values()) {
            bridge.abortAll();
        }
    }
}
