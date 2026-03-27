import { ClaudeBridge } from "./claude.js";
import type { SendCallbacks, TokenUsage, PermissionMode } from "./claude.js";
import type { RepoConfig } from "./repo-manager.js";
import { getRepoStateDir } from "./repo-manager.js";

/**
 * BridgeRouter — routes chatId to the correct ClaudeBridge based on the
 * user's currently selected repo. Proxies all ClaudeBridge methods so
 * that workers can use it as a drop-in replacement.
 */
export class BridgeRouter {
  private readonly botId: number;
  private readonly botUsername: string;

  /** repoPath → ClaudeBridge */
  private bridges = new Map<string, ClaudeBridge>();

  /** repoPath → RepoConfig */
  private repos = new Map<string, RepoConfig>();

  /** chatId → repoPath (current selection) */
  private currentRepo = new Map<number, string>();

  constructor(botId: number, botUsername: string) {
    this.botId = botId;
    this.botUsername = botUsername;
  }

  // ---- Repo management ----

  addRepo(repoConfig: RepoConfig): ClaudeBridge {
    const stateDir = getRepoStateDir(repoConfig.path);
    const bridge = new ClaudeBridge(this.botId, repoConfig.path, this.botUsername, stateDir);
    this.bridges.set(repoConfig.path, bridge);
    this.repos.set(repoConfig.path, repoConfig);
    return bridge;
  }

  removeRepo(repoPath: string): void {
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

  listRepos(): RepoConfig[] {
    return [...this.repos.values()];
  }

  // ---- Chat → Repo routing ----

  switchRepo(chatId: number, repoPath: string): void {
    if (!this.bridges.has(repoPath)) {
      throw new Error(`Repo not found: ${repoPath}`);
    }
    this.currentRepo.set(chatId, repoPath);
  }

  getCurrentRepo(chatId: number): RepoConfig | undefined {
    const repoPath = this.currentRepo.get(chatId);
    if (!repoPath) {
      // Auto-select first repo if available
      const first = this.repos.values().next().value as RepoConfig | undefined;
      if (first) {
        this.currentRepo.set(chatId, first.path);
        return first;
      }
      return undefined;
    }
    return this.repos.get(repoPath);
  }

  getBridge(chatId: number): ClaudeBridge | undefined {
    const repo = this.getCurrentRepo(chatId);
    if (!repo) return undefined;
    return this.bridges.get(repo.path);
  }

  /** Get bridge, throwing if no repo is selected */
  private requireBridge(chatId: number): ClaudeBridge {
    const bridge = this.getBridge(chatId);
    if (!bridge) throw new Error("No repo selected. Use /repo add to add one.");
    return bridge;
  }

  // ---- Proxied ClaudeBridge methods ----

  async sendMessage(
    chatId: number,
    prompt: string,
    callbacks: SendCallbacks,
    permissionMode?: PermissionMode,
    maxTurns?: number
  ): Promise<void> {
    return this.requireBridge(chatId).sendMessage(chatId, prompt, callbacks, permissionMode, maxTurns);
  }

  cancelQuery(chatId: number): boolean {
    const bridge = this.getBridge(chatId);
    return bridge ? bridge.cancelQuery(chatId) : false;
  }

  isProcessing(chatId: number): boolean {
    const bridge = this.getBridge(chatId);
    return bridge ? bridge.isProcessing(chatId) : false;
  }

  isCoolingDown(chatId: number): boolean {
    const bridge = this.getBridge(chatId);
    return bridge ? bridge.isCoolingDown(chatId) : false;
  }

  getSessionId(chatId: number): string | undefined {
    const bridge = this.getBridge(chatId);
    return bridge?.getSessionId(chatId);
  }

  setSessionId(chatId: number, sessionId: string): void {
    this.requireBridge(chatId).setSessionId(chatId, sessionId);
  }

  clearSession(chatId: number): void {
    const bridge = this.getBridge(chatId);
    bridge?.clearSession(chatId);
  }

  getModel(chatId: number): string {
    return this.requireBridge(chatId).getModel(chatId);
  }

  setModel(chatId: number, modelId: string): void {
    this.requireBridge(chatId).setModel(chatId, modelId);
  }

  getSessionTokens(chatId: number): TokenUsage {
    const bridge = this.getBridge(chatId);
    return bridge?.getSessionTokens(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }

  getPermissionMode(chatId: number): PermissionMode {
    return this.requireBridge(chatId).getPermissionMode(chatId);
  }

  setPermissionMode(chatId: number, mode: PermissionMode): void {
    this.requireBridge(chatId).setPermissionMode(chatId, mode);
  }

  allowUser(chatId: number, userId: number): void {
    this.requireBridge(chatId).allowUser(chatId, userId);
  }

  denyUser(chatId: number, userId: number): boolean {
    const bridge = this.getBridge(chatId);
    return bridge ? bridge.denyUser(chatId, userId) : false;
  }

  isAllowedUser(chatId: number, userId: number): boolean {
    const bridge = this.getBridge(chatId);
    return bridge ? bridge.isAllowedUser(chatId, userId) : false;
  }

  getAllowedUsers(chatId: number): number[] {
    const bridge = this.getBridge(chatId);
    return bridge?.getAllowedUsers(chatId) || [];
  }

  setLastPrompt(chatId: number, prompt: string): void {
    const bridge = this.getBridge(chatId);
    bridge?.setLastPrompt(chatId, prompt);
  }

  getLastPrompt(chatId: number): string | undefined {
    const bridge = this.getBridge(chatId);
    return bridge?.getLastPrompt(chatId);
  }

  getProjectSessionsDir(chatId?: number): string {
    // Get sessions dir from the current repo's bridge
    let bridge: ClaudeBridge | undefined;
    if (chatId !== undefined) {
      bridge = this.getBridge(chatId);
    } else {
      // Fallback: use first bridge if no chatId provided
      bridge = this.bridges.values().next().value as ClaudeBridge | undefined;
    }
    return bridge?.getProjectSessionsDir() || "";
  }

  listRecentSessions(limit?: number): Array<{ sessionId: string; modifiedAt: Date; promptPreview: string }> {
    // List sessions from the current bridge (if any)
    const firstBridge = this.bridges.values().next().value as ClaudeBridge | undefined;
    return firstBridge?.listRecentSessions(limit) || [];
  }

  getSessionHistory(sessionId: string, limit?: number): Array<{ role: "user" | "assistant"; text: string; timestamp: string }> {
    const firstBridge = this.bridges.values().next().value as ClaudeBridge | undefined;
    return firstBridge?.getSessionHistory(sessionId, limit) || [];
  }

  getTempDir(chatId?: number): string {
    if (chatId) {
      const bridge = this.getBridge(chatId);
      return bridge?.getTempDir() || "";
    }
    // Fallback: return first bridge's tempDir
    const firstBridge = this.bridges.values().next().value as ClaudeBridge | undefined;
    return firstBridge?.getTempDir() || "";
  }

  cleanupTempFiles(): void {
    // Clean up for all bridges
    for (const bridge of this.bridges.values()) {
      bridge.cleanupTempFiles();
    }
  }

  abortAll(): void {
    for (const bridge of this.bridges.values()) {
      bridge.abortAll();
    }
  }
}
