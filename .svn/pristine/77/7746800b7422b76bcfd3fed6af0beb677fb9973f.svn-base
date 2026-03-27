import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated temp HOME
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "elsa-router-test-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-DEF";
process.env.TELEGRAM_OWNER_ID = "999";

// Create fake repo directories
const repo1 = path.join(tmpHome, "repo-alpha");
const repo2 = path.join(tmpHome, "repo-beta");
fs.mkdirSync(repo1, { recursive: true });
fs.mkdirSync(repo2, { recursive: true });
// Create .elsa dirs
fs.mkdirSync(path.join(repo1, ".elsa"), { recursive: true });
fs.mkdirSync(path.join(repo2, ".elsa"), { recursive: true });

const { BridgeRouter } = await import("../src/bridge-router.js");
const { getRepoStateDir } = await import("../src/repo-manager.js");

after(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("BridgeRouter", () => {
  let router: InstanceType<typeof BridgeRouter>;

  beforeEach(() => {
    router = new BridgeRouter(12345, "testbot");
  });

  it("addRepo creates a bridge for the repo", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    const repos = router.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].alias, "alpha");
  });

  it("addRepo supports multiple repos", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.addRepo({ path: repo2, alias: "beta", addedAt: new Date().toISOString() });
    assert.equal(router.listRepos().length, 2);
  });

  it("removeRepo removes the bridge", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.addRepo({ path: repo2, alias: "beta", addedAt: new Date().toISOString() });
    router.removeRepo(repo1);
    assert.equal(router.listRepos().length, 1);
    assert.equal(router.listRepos()[0].alias, "beta");
  });

  it("getCurrentRepo auto-selects first repo", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.addRepo({ path: repo2, alias: "beta", addedAt: new Date().toISOString() });

    const current = router.getCurrentRepo(42);
    assert.ok(current);
    assert.equal(current!.alias, "alpha");
  });

  it("getCurrentRepo returns undefined when no repos", () => {
    assert.equal(router.getCurrentRepo(42), undefined);
  });

  it("switchRepo changes current repo for a chatId", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.addRepo({ path: repo2, alias: "beta", addedAt: new Date().toISOString() });

    router.switchRepo(42, repo2);
    const current = router.getCurrentRepo(42);
    assert.ok(current);
    assert.equal(current!.alias, "beta");
  });

  it("switchRepo throws for unknown repo", () => {
    assert.throws(() => router.switchRepo(42, "/nope"), /not found/);
  });

  it("different chatIds can have different repos", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.addRepo({ path: repo2, alias: "beta", addedAt: new Date().toISOString() });

    router.switchRepo(1, repo1);
    router.switchRepo(2, repo2);

    assert.equal(router.getCurrentRepo(1)!.alias, "alpha");
    assert.equal(router.getCurrentRepo(2)!.alias, "beta");
  });

  it("getBridge returns correct bridge after switch", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.addRepo({ path: repo2, alias: "beta", addedAt: new Date().toISOString() });

    router.switchRepo(42, repo2);
    const bridge = router.getBridge(42);
    assert.ok(bridge);
    assert.equal(bridge!.workingDir, repo2);
  });

  it("removeRepo unsets currentRepo for affected chatIds", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.switchRepo(42, repo1);
    router.removeRepo(repo1);

    assert.equal(router.getCurrentRepo(42), undefined);
  });

  it("proxy methods work through router", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });

    // These should not throw
    assert.equal(router.isProcessing(42), false);
    assert.equal(router.isCoolingDown(42), false);
    assert.equal(router.cancelQuery(42), false);
    assert.equal(router.getSessionId(42), undefined);
    assert.equal(router.getLastPrompt(42), undefined);

    // Set and get
    router.setLastPrompt(42, "hello");
    assert.equal(router.getLastPrompt(42), "hello");
  });

  it("proxy methods return defaults when no repo", () => {
    assert.equal(router.isProcessing(42), false);
    assert.equal(router.isCoolingDown(42), false);
    assert.equal(router.cancelQuery(42), false);
    assert.equal(router.getSessionId(42), undefined);

    const tokens = router.getSessionTokens(42);
    assert.equal(tokens.inputTokens, 0);
  });

  it("abortAll aborts all bridges", () => {
    router.addRepo({ path: repo1, alias: "alpha", addedAt: new Date().toISOString() });
    router.addRepo({ path: repo2, alias: "beta", addedAt: new Date().toISOString() });
    // Should not throw
    router.abortAll();
  });
});
