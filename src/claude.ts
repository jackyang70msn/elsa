import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { config } from "./config.js";
import { logTool, logStatus } from "./log.js";
import { resolveClaudePath } from "./store.js";

const COOLDOWN_MS = 2000;
const THINKING_ROTATE_MS = 1500;

export type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan";

export const AVAILABLE_PERMISSION_MODES = [
  { id: "bypassPermissions" as const, label: "Bypass", description: "Auto-approve all operations" },
  { id: "acceptEdits" as const, label: "Accept Edits", description: "Auto-approve file edits, deny Bash" },
  { id: "plan" as const, label: "Plan Only", description: "Read-only analysis, no modifications" },
] as const;

const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface SendCallbacks {
  onStreamChunk: (text: string) => void;
  onStatusUpdate: (status: string) => void;
  onToolApproval: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<"allow" | "always" | "deny">;
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

export const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

const DEFAULT_MODEL = AVAILABLE_MODELS[0].id;

// Claude Code-style spinner words shown during thinking
const THINKING_WORDS = [
  "Thinking...",
  "Reasoning...",
  "Analyzing...",
  "Contemplating...",
  "Processing...",
  "Investigating...",
  "Considering...",
  "Evaluating...",
  "Synthesizing...",
  "Formulating...",
  "Pondering...",
  "Deliberating...",
  "Examining...",
  "Deciphering...",
];

function formatToolStatus(toolName: string, detail?: string): string {
  const toolVerbs: Record<string, string> = {
    Read: "Reading",
    Bash: "Running",
    Edit: "Editing",
    MultiEdit: "Editing",
    Write: "Writing",
    Glob: "Searching files",
    Grep: "Searching code",
    WebSearch: "Searching",
    WebFetch: "Fetching",
    Task: "Running agent",
    TodoWrite: "Updating tasks",
    NotebookEdit: "Editing notebook",
    EnterPlanMode: "Planning",
    ExitPlanMode: "Finalizing plan",
  };
  const verb = toolVerbs[toolName] || `Using ${toolName}`;
  return detail ? `${verb}: ${detail}` : `${verb}...`;
}

// Full path/detail for terminal logs
function toolDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path || "");
    case "Bash":
      return String(input.command || "").slice(0, 80);
    case "Glob":
      return String(input.pattern || "");
    case "Grep":
      return String(input.pattern || "");
    default:
      return "";
  }
}

// Short detail for Telegram status (filename only, truncated commands)
function toolStatusDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return path.basename(String(input.file_path || ""));
    case "NotebookEdit":
      return path.basename(String(input.notebook_path || ""));
    case "Bash":
      return String(input.command || "").slice(0, 60);
    case "Glob":
      return String(input.pattern || "");
    case "Grep":
      return `"${String(input.pattern || "").slice(0, 40)}"`;
    case "WebSearch":
      return `"${String(input.query || "").slice(0, 40)}"`;
    case "WebFetch":
      return String(input.url || "").slice(0, 50);
    default:
      return "";
  }
}

interface PersistedState {
  sessions: Record<string, string>;
  sessionTokens: Record<string, TokenUsage>;
  selectedModels: Record<string, string>;
  allowedUsers?: Record<string, number[]>;
  permissionModes?: Record<string, PermissionMode>;
}

export class ClaudeBridge {
  readonly workingDir: string;
  readonly botId: number;
  private readonly tag: string;
  private readonly stateFile: string;

  private sessions = new Map<number, string>();
  private sessionTokens = new Map<number, TokenUsage>();
  private activeAborts = new Map<number, AbortController>();
  private selectedModels = new Map<number, string>();
  private lastQueryEnd = new Map<number, number>();
  private lastPrompts = new Map<number, string>();
  private allowedUsers = new Map<number, number[]>();
  private permissionModes = new Map<number, PermissionMode>();
  // Strip CLAUDECODE env var once so CLI subprocesses don't refuse to start
  // when the daemon is launched from within a Claude Code session.
  private readonly cleanEnv: Record<string, string | undefined>;

  constructor(botId: number, workingDir: string, tag: string, stateDir?: string) {
    this.botId = botId;
    this.workingDir = workingDir;
    this.tag = tag;
    // When stateDir is provided (e.g. <repo>/.elsa/), store state there.
    // Otherwise fall back to the global ~/.elsa/ directory.
    if (stateDir) {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      this.stateFile = path.join(stateDir, "state.json");
    } else {
      this.stateFile = path.join(config.DATA_DIR, `state-${botId}.json`);
    }
    const { CLAUDECODE: _, ...cleanEnv } = process.env;
    this.cleanEnv = cleanEnv;
    this.loadState();
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw: PersistedState = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
      for (const [k, v] of Object.entries(raw.sessions || {})) this.sessions.set(Number(k), v);
      for (const [k, v] of Object.entries(raw.sessionTokens || {})) this.sessionTokens.set(Number(k), v);
      for (const [k, v] of Object.entries(raw.selectedModels || {})) this.selectedModels.set(Number(k), v);
      for (const [k, v] of Object.entries(raw.allowedUsers || {})) this.allowedUsers.set(Number(k), v);
      for (const [k, v] of Object.entries(raw.permissionModes || {})) this.permissionModes.set(Number(k), v as PermissionMode);
    } catch {}
  }

  private saveState(): void {
    try {
      fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
      const state: PersistedState = {
        sessions: Object.fromEntries(this.sessions),
        sessionTokens: Object.fromEntries(this.sessionTokens),
        selectedModels: Object.fromEntries(this.selectedModels),
        allowedUsers: Object.fromEntries(this.allowedUsers),
        permissionModes: Object.fromEntries(this.permissionModes),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {}
  }

  isProcessing(chatId: number): boolean {
    return this.activeAborts.has(chatId);
  }

  getSessionTokens(chatId: number): TokenUsage {
    return this.sessionTokens.get(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }

  clearSession(chatId: number): void {
    this.sessions.delete(chatId);
    this.sessionTokens.delete(chatId);
    this.saveState();
  }

  setModel(chatId: number, modelId: string): void {
    this.selectedModels.set(chatId, modelId);
    this.sessions.delete(chatId);
    this.saveState();
  }

  getModel(chatId: number): string {
    return this.selectedModels.get(chatId) || DEFAULT_MODEL;
  }

  getSessionId(chatId: number): string | undefined {
    return this.sessions.get(chatId);
  }

  setSessionId(chatId: number, sessionId: string): void {
    this.sessions.set(chatId, sessionId);
    this.sessionTokens.delete(chatId);
    this.saveState();
  }

  getProjectSessionsDir(): string {
    const projectKey = this.workingDir.replace(/[\\/]/g, "-");
    return path.join(os.homedir(), ".claude", "projects", projectKey);
  }

  listRecentSessions(limit = 10): Array<{ sessionId: string; modifiedAt: Date; promptPreview: string }> {
    const dir = this.getProjectSessionsDir();
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        return { name: f, fullPath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    return files.map(({ name, fullPath, mtime }) => {
      const sessionId = name.replace(/\.jsonl$/, "");
      let promptPreview = "(no preview)";

      try {
        const fd = fs.openSync(fullPath, "r");
        const buf = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);

        const chunk = buf.toString("utf-8", 0, bytesRead);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "user" && entry.sessionId === sessionId) {
              const content = entry.message?.content;
              let text = "";
              if (typeof content === "string") {
                text = content;
              } else if (Array.isArray(content)) {
                const textBlock = content.find((b: Record<string, unknown>) => b.type === "text");
                if (textBlock) text = String(textBlock.text || "");
              }
              if (text) {
                promptPreview = text.length > 80 ? text.slice(0, 80) + "..." : text;
                break;
              }
            }
          } catch {}
        }
      } catch {}

      return { sessionId, modifiedAt: new Date(mtime), promptPreview };
    });
  }

  getSessionHistory(sessionId: string, limit = 10): Array<{ role: "user" | "assistant"; text: string; timestamp: string }> {
    try {
      const filePath = path.join(this.getProjectSessionsDir(), `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) return [];

      const raw = fs.readFileSync(filePath, "utf-8");
      const entries: Array<{ role: "user" | "assistant"; text: string; timestamp: string }> = [];

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user" && entry.type !== "assistant") continue;

          const content = entry.message?.content;
          let text = "";

          if (entry.type === "user") {
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b: Record<string, unknown>) => b.type === "text");
              if (textBlock) text = String(textBlock.text || "");
            }
          } else {
            // assistant — extract only text blocks, skip thinking/tool_use
            if (Array.isArray(content)) {
              const texts = content
                .filter((b: Record<string, unknown>) => b.type === "text")
                .map((b: Record<string, unknown>) => String(b.text || ""));
              text = texts.join("\n");
            }
          }

          if (!text.trim()) continue;

          const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
          entries.push({
            role: entry.type as "user" | "assistant",
            text: truncated,
            timestamp: entry.timestamp || "",
          });
        } catch {}
      }

      return entries.slice(-limit);
    } catch {
      return [];
    }
  }

  cancelQuery(chatId: number): boolean {
    const controller = this.activeAborts.get(chatId);
    if (controller) {
      controller.abort();
      this.activeAborts.delete(chatId);
      return true;
    }
    return false;
  }

  isCoolingDown(chatId: number): boolean {
    const last = this.lastQueryEnd.get(chatId);
    if (!last) return false;
    return Date.now() - last < COOLDOWN_MS;
  }

  setLastPrompt(chatId: number, prompt: string): void {
    this.lastPrompts.set(chatId, prompt);
  }

  getLastPrompt(chatId: number): string | undefined {
    return this.lastPrompts.get(chatId);
  }

  isAllowedUser(chatId: number, userId: number): boolean {
    const list = this.allowedUsers.get(chatId);
    return list !== undefined && list.includes(userId);
  }

  allowUser(chatId: number, userId: number): void {
    const list = this.allowedUsers.get(chatId) || [];
    if (!list.includes(userId)) {
      list.push(userId);
      this.allowedUsers.set(chatId, list);
      this.saveState();
    }
  }

  denyUser(chatId: number, userId: number): boolean {
    const list = this.allowedUsers.get(chatId);
    if (!list) return false;
    const idx = list.indexOf(userId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.allowedUsers.delete(chatId);
    else this.allowedUsers.set(chatId, list);
    this.saveState();
    return true;
  }

  getAllowedUsers(chatId: number): number[] {
    return this.allowedUsers.get(chatId) || [];
  }

  setPermissionMode(chatId: number, mode: PermissionMode): void {
    this.permissionModes.set(chatId, mode);
    this.saveState();
  }

  getPermissionMode(chatId: number): PermissionMode {
    return this.permissionModes.get(chatId) || DEFAULT_PERMISSION_MODE;
  }

  abortAll(): void {
    for (const [, controller] of this.activeAborts) {
      controller.abort();
    }
    this.activeAborts.clear();
  }

  getTempDir(): string {
    // Store temp files inside the working directory so Claude CLI can read them
    // (Claude may not have access to system temp dirs outside the working dir)
    return path.join(this.workingDir, ".elsa-tmp");
  }

  cleanupTempFiles(): void {
    try {
      const tmpDir = this.getTempDir();
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        for (const f of files) {
          fs.unlinkSync(path.join(tmpDir, f));
        }
        fs.rmdirSync(tmpDir);
      }
    } catch {}
  }

  private spawnClaude(opts: {
    prompt: string;
    model: string;
    sessionId?: string;
    maxTurns?: number;
    permissionMode?: PermissionMode;
  }): ChildProcess {
    const mode = opts.permissionMode || DEFAULT_PERMISSION_MODE;
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--model", opts.model,
      "--verbose",
    ];
    if (mode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", mode);
    }
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }
    if (opts.maxTurns) {
      args.push("--max-turns", String(opts.maxTurns));
    }
    // Pass prompt via stdin to avoid shell escaping issues on Windows
    // (e.g. apostrophes in "I've" get mangled by cmd.exe shell mode)
    const child = spawn(resolveClaudePath(), args, {
      cwd: this.workingDir,
      env: this.cleanEnv as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Write prompt to stdin and close — CLI reads from stdin when no prompt arg given
    child.stdin?.write(opts.prompt);
    child.stdin?.end();

    return child;
  }

  private stderrBuffer = "";

  private async *parseCliStream(child: ChildProcess): AsyncGenerator<Record<string, unknown>> {
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    // Capture stderr for error diagnostics
    child.stderr?.on("data", (data) => {
      this.stderrBuffer += data.toString();
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Non-JSON line from CLI — skip
      }
    }
  }

  async sendMessage(
    chatId: number,
    prompt: string,
    callbacks: SendCallbacks,
    permissionMode?: PermissionMode,
    maxTurns?: number
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeAborts.set(chatId, abortController);
    this.stderrBuffer = ""; // Clear stderr buffer at start of new query

    const sessionId = this.sessions.get(chatId);
    let hasStreamedText = false;

    let wordIdx = Math.floor(Math.random() * THINKING_WORDS.length);
    const thinkingInterval = setInterval(() => {
      if (hasStreamedText || abortController.signal.aborted) {
        clearInterval(thinkingInterval);
        return;
      }
      wordIdx = (wordIdx + 1) % THINKING_WORDS.length;
      const word = THINKING_WORDS[wordIdx];
      callbacks.onStatusUpdate(word);
      logStatus(word, this.tag);
    }, THINKING_ROTATE_MS);

    const model = this.selectedModels.get(chatId) || DEFAULT_MODEL;
    const effectiveMode = permissionMode || this.getPermissionMode(chatId);
    const child = this.spawnClaude({ prompt, model, sessionId, maxTurns, permissionMode: effectiveMode });

    // Kill child process on abort
    const onAbort = () => { try { child.kill(); } catch {} };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Track tool_use blocks from stream events to capture Write file paths
      let streamToolName = "";
      let streamToolInputJson = "";

      for await (const message of this.parseCliStream(child)) {
        if (abortController.signal.aborted) break;

        if (message.type === "system" && message.subtype === "init") {
          const msgSessionId = message.session_id as string;
          if (sessionId && msgSessionId !== sessionId) {
            callbacks.onSessionReset?.();
          }
          this.sessions.set(chatId, msgSessionId);
        } else if (message.type === "assistant" && message.subtype === "tool_use") {
          // CLI stream-json emits tool_use messages with tool name and input
          const toolName = message.tool_name as string || "";
          const input = message.input as Record<string, unknown> || {};
          const detail = toolDetail(toolName, input);
          const statusDetail = toolStatusDetail(toolName, input) || undefined;
          logTool(toolName, detail, this.tag);
          callbacks.onStatusUpdate(formatToolStatus(toolName, statusDetail));
        } else if (message.type === "assistant" && message.subtype === "tool_result") {
          // Tool result — no action needed, just log
        } else if (message.type === "stream_event") {
          const event = message.event as Record<string, unknown>;
          if (event.type === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (block?.type === "tool_use" && typeof block.name === "string") {
              streamToolName = block.name;
              streamToolInputJson = "";
              const status = formatToolStatus(block.name);
              callbacks.onStatusUpdate(status);
              logStatus(status, this.tag);
            } else if (block?.type === "thinking") {
              callbacks.onStatusUpdate("Thinking deeply...");
              logStatus("Thinking deeply...", this.tag);
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              if (!hasStreamedText) {
                hasStreamedText = true;
                clearInterval(thinkingInterval);
              }
              callbacks.onStreamChunk(delta.text);
            } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              streamToolInputJson += delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            streamToolName = "";
            streamToolInputJson = "";
          }
        } else if (message.type === "result") {
          clearInterval(thinkingInterval);
          if (message.subtype === "success") {
            const rawUsage = message.usage as Record<string, number> | undefined;
            const usage: TokenUsage = {
              inputTokens: rawUsage?.input_tokens || 0,
              outputTokens: rawUsage?.output_tokens || 0,
              cacheCreationTokens: rawUsage?.cache_creation_input_tokens || 0,
              cacheReadTokens: rawUsage?.cache_read_input_tokens || 0,
            };

            const prev = this.sessionTokens.get(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
            this.sessionTokens.set(chatId, {
              inputTokens: prev.inputTokens + usage.inputTokens,
              outputTokens: prev.outputTokens + usage.outputTokens,
              cacheCreationTokens: prev.cacheCreationTokens + usage.cacheCreationTokens,
              cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
            });
            this.saveState();

            callbacks.onResult({
              text: message.result as string || "",
              usage,
              turns: message.num_turns as number || 0,
              durationMs: message.duration_ms as number || 0,
            });
          } else {
            const errors = message.errors as string[] | undefined;
            const errorMsg = errors?.join(", ") || this.stderrBuffer.trim() || "Claude query failed";
            callbacks.onError(new Error(errorMsg));
          }
          break;
        }
      }
    } catch (error) {
      clearInterval(thinkingInterval);
      if (!abortController.signal.aborted) {
        let err = error instanceof Error ? error : new Error(String(error));
        // If stderr has more context, append it
        if (this.stderrBuffer.trim()) {
          err = new Error(`${err.message}\n${this.stderrBuffer.trim()}`);
        }
        callbacks.onError(err);
      }
    } finally {
      clearInterval(thinkingInterval);
      abortController.signal.removeEventListener("abort", onAbort);
      this.activeAborts.delete(chatId);
      this.lastQueryEnd.set(chatId, Date.now());
      // Ensure child process is killed
      try { child.kill(); } catch {}
      this.cleanupTempFiles();
    }
  }
}
