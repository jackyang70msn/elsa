import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Create isolated temp HOME + repo directories
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "elsa-repo-test-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-DEF";
process.env.TELEGRAM_OWNER_ID = "999";

// Create fake repo directories for testing
const fakeRepo1 = path.join(tmpHome, "project-alpha");
const fakeRepo2 = path.join(tmpHome, "project-beta");
const fakeRepo3 = path.join(tmpHome, "project-alpha-2");
fs.mkdirSync(fakeRepo1, { recursive: true });
fs.mkdirSync(fakeRepo2, { recursive: true });
fs.mkdirSync(fakeRepo3, { recursive: true });

const { loadRepos, addRepo, removeRepo, getRepoByAlias, getRepoByPath, deriveAlias, getRepoStateDir } =
  await import("../src/repo-manager.js");
const { config } = await import("../src/config.js");

const reposFile = path.join(config.DATA_DIR, "repos.json");

function cleanup() {
  try { fs.unlinkSync(reposFile); } catch {}
}

after(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("RepoManager", () => {
  beforeEach(cleanup);

  it("loadRepos returns empty array when no file exists", () => {
    assert.deepStrictEqual(loadRepos(), []);
  });

  it("addRepo creates a repo entry and .elsa directory", () => {
    const repo = addRepo(fakeRepo1);
    assert.equal(repo.alias, "project-alpha");
    assert.equal(repo.path, fakeRepo1);
    assert.ok(repo.addedAt);

    // .elsa directory should be created
    assert.ok(fs.existsSync(path.join(fakeRepo1, ".elsa")));

    // Should be persisted
    const repos = loadRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].alias, "project-alpha");
  });

  it("addRepo with custom alias", () => {
    const repo = addRepo(fakeRepo1, "myrepo");
    assert.equal(repo.alias, "myrepo");
  });

  it("addRepo rejects duplicate path", () => {
    addRepo(fakeRepo1);
    assert.throws(() => addRepo(fakeRepo1), /already added/);
  });

  it("addRepo rejects duplicate alias", () => {
    addRepo(fakeRepo1, "shared-alias");
    assert.throws(() => addRepo(fakeRepo2, "shared-alias"), /already in use/);
  });

  it("addRepo rejects non-existent path", () => {
    assert.throws(() => addRepo("/does/not/exist"), /does not exist/);
  });

  it("removeRepo removes by alias", () => {
    addRepo(fakeRepo1, "alpha");
    addRepo(fakeRepo2, "beta");

    const removed = removeRepo("alpha");
    assert.ok(removed);
    assert.equal(removed!.alias, "alpha");

    const repos = loadRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].alias, "beta");
  });

  it("removeRepo returns null for non-existent alias", () => {
    assert.equal(removeRepo("nope"), null);
  });

  it("getRepoByAlias finds correct repo", () => {
    addRepo(fakeRepo1, "alpha");
    addRepo(fakeRepo2, "beta");

    const found = getRepoByAlias("beta");
    assert.ok(found);
    assert.equal(found!.path, fakeRepo2);
  });

  it("getRepoByPath finds correct repo", () => {
    addRepo(fakeRepo1);

    const found = getRepoByPath(fakeRepo1);
    assert.ok(found);
    assert.equal(found!.alias, "project-alpha");
  });

  it("getRepoStateDir returns .elsa path inside repo", () => {
    const dir = getRepoStateDir(fakeRepo1);
    assert.equal(dir, path.join(fakeRepo1, ".elsa"));
  });
});

describe("deriveAlias", () => {
  it("derives alias from last path segment", () => {
    assert.equal(deriveAlias("/foo/bar/my-project", []), "my-project");
  });

  it("appends suffix on collision", () => {
    const existing = [{ path: "/a", alias: "project-alpha", addedAt: "" }];
    assert.equal(deriveAlias(fakeRepo1, existing), "project-alpha-2");
  });

  it("strips non-alphanumeric characters", () => {
    assert.equal(deriveAlias("/foo/My Project (v2)", []), "myprojectv2");
  });
});
