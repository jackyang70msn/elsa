import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const REPOS_FILE = path.join(DATA_DIR, "repos.json");

export interface RepoConfig {
  path: string;     // Absolute path to the repo
  alias: string;    // Short name for /repo switch
  addedAt: string;  // ISO timestamp
}

// --- Persistence ---

export function loadRepos(): RepoConfig[] {
  try {
    if (!fs.existsSync(REPOS_FILE)) return [];
    return JSON.parse(fs.readFileSync(REPOS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveRepos(repos: RepoConfig[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2), { mode: 0o600 });
}

// --- .elsa directory inside each repo ---

function ensureRepoElsaDir(repoPath: string): void {
  const elsaDir = path.join(repoPath, ".elsa");
  fs.mkdirSync(elsaDir, { recursive: true, mode: 0o700 });

  // Auto-add .elsa/ to .gitignore if it exists
  const gitignorePath = path.join(repoPath, ".gitignore");
  try {
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      if (!content.includes(".elsa")) {
        const nl = content.endsWith("\n") ? "" : "\n";
        fs.appendFileSync(gitignorePath, `${nl}.elsa/\n`);
      }
    }
  } catch {
    // Not critical — skip silently
  }
}

// --- Alias derivation ---

export function deriveAlias(repoPath: string, existing: RepoConfig[]): string {
  const base = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const alias = base || "repo";
  const taken = new Set(existing.map((r) => r.alias));
  if (!taken.has(alias)) return alias;

  // Append numeric suffix
  for (let i = 2; i <= 100; i++) {
    const candidate = `${alias}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${alias}-${Date.now()}`;
}

// --- CRUD ---

export function addRepo(repoPath: string, alias?: string): RepoConfig {
  const absPath = path.resolve(repoPath);

  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    throw new Error(`Path does not exist or is not a directory: ${absPath}`);
  }

  const repos = loadRepos();

  // Check for duplicate path
  if (repos.some((r) => r.path === absPath)) {
    throw new Error(`Repo already added: ${absPath}`);
  }

  const finalAlias = alias || deriveAlias(absPath, repos);

  // Check for duplicate alias
  if (repos.some((r) => r.alias === finalAlias)) {
    throw new Error(`Alias "${finalAlias}" already in use`);
  }

  ensureRepoElsaDir(absPath);

  const config: RepoConfig = {
    path: absPath,
    alias: finalAlias,
    addedAt: new Date().toISOString(),
  };

  repos.push(config);
  saveRepos(repos);
  return config;
}

export function removeRepo(alias: string): RepoConfig | null {
  const repos = loadRepos();
  const idx = repos.findIndex((r) => r.alias === alias);
  if (idx === -1) return null;

  const [removed] = repos.splice(idx, 1);
  saveRepos(repos);
  return removed;
}

export function getRepoByAlias(alias: string): RepoConfig | undefined {
  return loadRepos().find((r) => r.alias === alias);
}

export function getRepoByPath(repoPath: string): RepoConfig | undefined {
  const absPath = path.resolve(repoPath);
  return loadRepos().find((r) => r.path === absPath);
}

/** Returns the .elsa state directory for a given repo path */
export function getRepoStateDir(repoPath: string): string {
  return path.join(repoPath, ".elsa");
}
