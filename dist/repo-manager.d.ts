export interface RepoConfig {
    path: string;
    alias: string;
    addedAt: string;
}
export declare function loadRepos(): RepoConfig[];
export declare function deriveAlias(repoPath: string, existing: RepoConfig[]): string;
export declare function addRepo(repoPath: string, alias?: string): RepoConfig;
export declare function removeRepo(alias: string): RepoConfig | null;
export declare function getRepoByAlias(alias: string): RepoConfig | undefined;
export declare function getRepoByPath(repoPath: string): RepoConfig | undefined;
/** Returns the .elsa state directory for a given repo path */
export declare function getRepoStateDir(repoPath: string): string;
