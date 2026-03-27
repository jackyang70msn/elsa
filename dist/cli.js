#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const DATA_DIR = path.join(os.homedir(), ".elsa");
const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const LOG_FILE = path.join(DATA_DIR, "app.log");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const LOG_KEEP_COUNT = 3; // keep app.log.1, app.log.2, app.log.3
const LAUNCHD_LABEL = "com.elsa.daemon";
// Resolve daemon path: prefer compiled dist/daemon.js, fall back to tsx for local dev
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiledDaemon = path.join(__dirname, "daemon.js");
const srcDaemon = path.join(__dirname, "../src/daemon.ts");
// For global installs, compiledDaemon exists and we use node directly (no shell needed).
// For local dev, we use npx tsx — resolve npx to a full path to avoid shell:true on Windows.
function resolveDaemonCmd() {
    if (fs.existsSync(compiledDaemon)) {
        return [process.execPath, [compiledDaemon]];
    }
    // Local dev: use node to run npx-cli.js directly (avoids shell:true on Windows)
    if (process.platform === "win32") {
        const npmDir = path.dirname(process.execPath);
        const npxCli = path.join(npmDir, "node_modules", "npm", "bin", "npx-cli.js");
        if (fs.existsSync(npxCli)) {
            return [process.execPath, [npxCli, "tsx", srcDaemon]];
        }
    }
    return ["npx", ["tsx", srcDaemon]];
}
const DAEMON_CMD = resolveDaemonCmd();
function rotateLog() {
    try {
        if (!fs.existsSync(LOG_FILE))
            return;
        const stat = fs.statSync(LOG_FILE);
        if (stat.size < LOG_MAX_BYTES)
            return;
        // Shift existing rotated logs: app.log.2 → app.log.3, app.log.1 → app.log.2, etc.
        for (let i = LOG_KEEP_COUNT - 1; i >= 1; i--) {
            const from = `${LOG_FILE}.${i}`;
            const to = `${LOG_FILE}.${i + 1}`;
            if (fs.existsSync(from))
                fs.renameSync(from, to);
        }
        // Current log becomes app.log.1
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    catch { }
}
function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readPid() {
    try {
        if (!fs.existsSync(PID_FILE))
            return null;
        const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        return isNaN(pid) ? null : pid;
    }
    catch {
        return null;
    }
}
function spawnExec(cmd, args) {
    return new Promise((resolve) => {
        let stderr = "";
        const child = spawn(cmd, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr.on("data", (data) => { stderr += data.toString(); });
        child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
        child.on("error", (err) => resolve({ code: 1, stderr: err.message }));
    });
}
function launchctlExec(args) {
    return spawnExec("launchctl", args);
}
function systemctlExec(args) {
    return spawnExec("systemctl", ["--user", ...args]);
}
function hasSystemd() {
    try {
        fs.accessSync("/run/systemd/system");
        return true;
    }
    catch {
        return false;
    }
}
function getSystemdServicePath() {
    return path.join(os.homedir(), ".config", "systemd", "user", "elsa.service");
}
/** Poll for daemon PID file + running process. Returns PID or null on timeout. */
async function waitForDaemon(timeoutMs = 10_000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pid = readPid();
        if (pid && isRunning(pid))
            return pid;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
}
/** Read the last N bytes of a file and return the last `lineCount` lines. */
function readTailLines(filePath, lineCount, maxBytes = 32_768) {
    let fd;
    try {
        fd = fs.openSync(filePath, "r");
    }
    catch {
        return [];
    }
    try {
        const stat = fs.fstatSync(fd);
        const readSize = Math.min(stat.size, maxBytes);
        if (readSize === 0)
            return [];
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
        const lines = buf.toString("utf-8").split("\n");
        // If the file was larger than maxBytes, the first "line" is likely truncated — drop it
        if (stat.size > maxBytes)
            lines.shift();
        // Drop trailing empty line from final newline
        if (lines.length > 0 && lines[lines.length - 1] === "")
            lines.pop();
        return lines.slice(-lineCount);
    }
    finally {
        fs.closeSync(fd);
    }
}
async function startDirect() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    rotateLog();
    const logFd = fs.openSync(LOG_FILE, "a");
    const [cmd, args] = DAEMON_CMD;
    const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        ...(process.platform === "win32" && { windowsHide: true }),
    });
    child.on("error", (err) => {
        console.error(`Failed to start daemon: ${err.message}`);
        fs.rmSync(PID_FILE, { force: true });
    });
    if (child.pid == null) {
        fs.closeSync(logFd);
        console.error("Failed to start daemon: spawn returned no PID.");
        return;
    }
    child.unref();
    fs.closeSync(logFd);
    // Don't write PID here — let the daemon write its own PID.
    // Poll for the daemon's PID file to confirm it started successfully.
    const daemonPid = await waitForDaemon(10_000, 200);
    if (daemonPid) {
        console.log(`Started (PID ${daemonPid})`);
        console.log(`Logs: elsa logs`);
    }
    else {
        console.error("Failed to start daemon (timeout).");
        console.error("Check logs: elsa logs");
    }
}
async function cmdSetup() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
    console.log("Elsa — Setup\n");
    // Platform selection
    console.log("Which platform(s) do you want to use?");
    console.log("  1. Telegram");
    console.log("  2. Discord");
    console.log("  3. Both\n");
    let platform = "";
    while (!["1", "2", "3"].includes(platform)) {
        platform = (await ask("  Choose (1/2/3): ")).trim();
    }
    const setupTelegram = platform === "1" || platform === "3";
    const setupDiscord = platform === "2" || platform === "3";
    const configData = {};
    const summaryLines = [];
    let totalSteps = (setupTelegram ? 2 : 0) + (setupDiscord ? 3 : 0) + 1; // +1 for ngrok
    let step = 0;
    // --- Telegram setup ---
    if (setupTelegram) {
        step++;
        console.log(`\nStep ${step}/${totalSteps}: Telegram Manager Bot`);
        console.log("  Create a bot via @BotFather on Telegram and paste the token here.");
        console.log("  It looks like: 123456:ABC-DEF...\n");
        let token = "";
        let botUsername = "";
        while (true) {
            token = (await ask("  Bot token: ")).trim();
            if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
                console.log("  Invalid format. Token looks like: 123456:ABC-DEF...\n");
                continue;
            }
            try {
                const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
                const data = (await res.json());
                if (!data.ok) {
                    console.log("  Token rejected by Telegram. Check it and try again.\n");
                    continue;
                }
                botUsername = data.result.username;
                console.log(`  Connected to @${botUsername}\n`);
                break;
            }
            catch {
                console.log("  Could not reach Telegram API. Check your connection.\n");
                continue;
            }
        }
        configData.TELEGRAM_BOT_TOKEN = token;
        step++;
        console.log(`Step ${step}/${totalSteps}: Your Telegram ID`);
        console.log("  This ensures only you can use the bot.");
        console.log("  To find your ID:");
        console.log("    1. Open Telegram and search for @userinfobot");
        console.log("    2. Send it any message — it replies with your user ID\n");
        let ownerIds = [];
        while (true) {
            const ownerIdStr = (await ask("  Telegram owner ID(s) (comma-separated for multiple): ")).trim();
            const parsed = ownerIdStr.split(",").map((s) => parseInt(s.trim(), 10));
            const valid = parsed.filter((n) => !isNaN(n) && n > 0);
            if (valid.length === 0) {
                console.log("  Invalid — enter at least one positive number.\n");
                continue;
            }
            ownerIds = valid;
            console.log(`  Owner(s) set to: ${ownerIds.join(", ")}\n`);
            break;
        }
        configData.TELEGRAM_OWNER_ID = ownerIds.length === 1 ? ownerIds[0] : ownerIds;
        summaryLines.push(`  Telegram: @${botUsername} (owner: ${ownerIds.join(", ")})`);
    }
    // --- Discord setup ---
    if (setupDiscord) {
        step++;
        console.log(`\nStep ${step}/${totalSteps}: Discord Manager Bot Token`);
        console.log("  Create a bot at https://discord.com/developers/applications");
        console.log("  Go to Bot → Reset Token → copy the token here.\n");
        let discordToken = "";
        while (true) {
            discordToken = (await ask("  Discord bot token: ")).trim();
            if (!discordToken) {
                console.log("  Token cannot be empty.\n");
                continue;
            }
            // Validate by calling Discord API
            try {
                const res = await fetch("https://discord.com/api/v10/users/@me", {
                    headers: { Authorization: `Bot ${discordToken}` },
                });
                const data = (await res.json());
                if (!data.id) {
                    console.log(`  Token rejected by Discord: ${data.message || "unknown error"}. Try again.\n`);
                    continue;
                }
                console.log(`  Connected to ${data.username}#${data.id}\n`);
                break;
            }
            catch {
                console.log("  Could not reach Discord API. Check your connection.\n");
                continue;
            }
        }
        configData.DISCORD_BOT_TOKEN = discordToken;
        step++;
        console.log(`Step ${step}/${totalSteps}: Discord Guild (Server) ID`);
        console.log("  Right-click your server name → Copy Server ID");
        console.log("  (Enable Developer Mode in Settings → App Settings → Advanced)\n");
        let guildId = "";
        while (true) {
            guildId = (await ask("  Guild ID: ")).trim();
            if (/^\d{17,20}$/.test(guildId))
                break;
            console.log("  Invalid — should be a 17-20 digit number.\n");
        }
        configData.DISCORD_GUILD_ID = guildId;
        step++;
        console.log(`\nStep ${step}/${totalSteps}: Your Discord User ID`);
        console.log("  Right-click your username → Copy User ID\n");
        let discordOwnerIds = [];
        while (true) {
            const idStr = (await ask("  Discord owner ID(s) (comma-separated for multiple): ")).trim();
            const parsed = idStr.split(",").map((s) => s.trim()).filter((s) => /^\d{17,20}$/.test(s));
            if (parsed.length === 0) {
                console.log("  Invalid — enter at least one 17-20 digit number.\n");
                continue;
            }
            discordOwnerIds = parsed;
            console.log(`  Owner(s) set to: ${discordOwnerIds.join(", ")}\n`);
            break;
        }
        configData.DISCORD_OWNER_ID = discordOwnerIds.length === 1 ? discordOwnerIds[0] : discordOwnerIds;
        summaryLines.push(`  Discord: guild ${guildId} (owner: ${discordOwnerIds.join(", ")})`);
    }
    // --- Ngrok (optional, shared) ---
    step++;
    console.log(`Step ${step}/${totalSteps}: Ngrok Configuration (optional, for live preview)`);
    console.log("  To preview your dev server from your phone, Elsa can create ngrok tunnels.");
    console.log("  Get a free auth token at: https://dashboard.ngrok.com/get-started/your-authtoken");
    console.log("  Press Enter to skip.\n");
    const ngrokToken = (await ask("  Ngrok auth token: ")).trim();
    if (ngrokToken) {
        configData.NGROK_AUTH_TOKEN = ngrokToken;
        console.log("  Ngrok token saved.\n");
    }
    else {
        console.log("  Skipped — you can configure it later via NGROK_AUTH_TOKEN env var or re-run setup.\n");
    }
    // Write config (merge with existing if present)
    let existingConfig = {};
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            existingConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
        }
    }
    catch { /* ignore */ }
    const merged = { ...existingConfig, ...configData };
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
    rl.close();
    // Completion summary
    console.log("Setup complete!");
    for (const line of summaryLines)
        console.log(line);
    // Auto-install service on macOS (launchd) and Linux (systemd) for startup persistence
    if (process.platform === "darwin" || (process.platform === "linux" && hasSystemd())) {
        console.log("\nInstalling auto-start service...");
        await cmdInstallService();
    }
    else {
        console.log("  Run: elsa start");
    }
}
async function cmdStart() {
    const pid = readPid();
    if (pid && isRunning(pid)) {
        console.log(`Already running (PID ${pid})`);
        return;
    }
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error("Not configured. Run: elsa setup");
        process.exit(1);
    }
    // On macOS with launchd service installed, use launchctl to start
    if (process.platform === "darwin" && fs.existsSync(getPlistPath())) {
        // Unload stale service first — fixes "Load failed: 5: Input/output error"
        // which occurs when the plist is already loaded from a previous session
        await launchctlExec(["unload", getPlistPath()]);
        const { code, stderr } = await launchctlExec(["load", getPlistPath()]);
        // launchctl can exit 0 even on failure (macOS quirk) — check stderr too
        const loadFailed = code !== 0 || stderr.includes("Load failed");
        if (loadFailed) {
            console.error(`launchd: ${stderr.trim() || `exit code ${code}`}`);
            console.log("Starting directly instead...");
            await startDirect();
            return;
        }
        const newPid = await waitForDaemon();
        if (newPid) {
            console.log(`Started via launchd (PID ${newPid})`);
            console.log(`Logs: elsa logs`);
        }
        else {
            // Daemon didn't start — show diagnostics and fall back to direct
            console.error("Daemon did not start via launchd.");
            if (fs.existsSync(LOG_FILE)) {
                const lines = readTailLines(LOG_FILE, 5);
                if (lines.length > 0) {
                    console.error("Recent logs:\n  " + lines.join("\n  "));
                }
            }
            else {
                console.error("No log file — daemon crashed before writing output.");
                console.error("Run manually to see errors:");
                console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
            }
            console.log("\nFalling back to direct start...");
            await launchctlExec(["unload", getPlistPath()]);
            await startDirect();
        }
        return;
    }
    // On macOS without service installed, install it now
    if (process.platform === "darwin") {
        console.log("Installing auto-start service...");
        await cmdInstallService();
        return;
    }
    // On Linux with systemd service installed, use systemctl to start
    if (process.platform === "linux" && fs.existsSync(getSystemdServicePath())) {
        const { code, stderr } = await systemctlExec(["start", "elsa"]);
        if (code !== 0) {
            console.error(`systemd: ${stderr.trim() || `exit code ${code}`}`);
            console.log("Starting directly instead...");
            await startDirect();
            return;
        }
        const newPid = await waitForDaemon();
        if (newPid) {
            console.log(`Started via systemd (PID ${newPid})`);
            console.log(`Logs: elsa logs`);
        }
        else {
            console.error("Daemon did not start via systemd.");
            if (fs.existsSync(LOG_FILE)) {
                const lines = readTailLines(LOG_FILE, 5);
                if (lines.length > 0) {
                    console.error("Recent logs:\n  " + lines.join("\n  "));
                }
            }
            else {
                console.error("No log file — daemon crashed before writing output.");
                console.error("Run manually to see errors:");
                console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
            }
            console.log("\nFalling back to direct start...");
            await systemctlExec(["stop", "elsa"]);
            await startDirect();
        }
        return;
    }
    // On Linux without service, install systemd service if available
    if (process.platform === "linux" && hasSystemd()) {
        console.log("Installing auto-start service...");
        await cmdInstallService();
        return;
    }
    startDirect();
}
async function cmdStop() {
    // On macOS with launchd service installed, use launchctl to unload so
    // KeepAlive doesn't immediately restart the daemon
    if (process.platform === "darwin" && fs.existsSync(getPlistPath())) {
        const pid = readPid();
        const { code } = await launchctlExec(["unload", getPlistPath()]);
        if (code === 0) {
            fs.rmSync(PID_FILE, { force: true });
            console.log("Stopped (launchd service unloaded).");
        }
        else {
            // Fall back to SIGTERM if launchctl fails
            if (pid && isRunning(pid)) {
                process.kill(pid, "SIGTERM");
                fs.rmSync(PID_FILE, { force: true });
                console.log(`Stopped (PID ${pid})`);
            }
            else {
                fs.rmSync(PID_FILE, { force: true });
                console.log("Not running.");
            }
        }
        return;
    }
    // On Linux with systemd service installed, use systemctl to stop so
    // Restart=always doesn't immediately restart the daemon
    if (process.platform === "linux" && fs.existsSync(getSystemdServicePath())) {
        const pid = readPid();
        const { code } = await systemctlExec(["stop", "elsa"]);
        if (code === 0) {
            fs.rmSync(PID_FILE, { force: true });
            console.log("Stopped (systemd service stopped).");
        }
        else {
            if (pid && isRunning(pid)) {
                process.kill(pid, "SIGTERM");
                fs.rmSync(PID_FILE, { force: true });
                console.log(`Stopped (PID ${pid})`);
            }
            else {
                fs.rmSync(PID_FILE, { force: true });
                console.log("Not running.");
            }
        }
        return;
    }
    const pid = readPid();
    if (!pid || !isRunning(pid)) {
        console.log("Not running.");
        fs.rmSync(PID_FILE, { force: true });
        return;
    }
    process.kill(pid, "SIGTERM");
    fs.rmSync(PID_FILE, { force: true });
    console.log(`Stopped (PID ${pid})`);
}
function cmdStatus() {
    const pid = readPid();
    if (!pid || !isRunning(pid)) {
        console.log("Status: stopped");
        return;
    }
    console.log(`Status: running (PID ${pid})`);
    console.log(`Logs: ${LOG_FILE}`);
}
function cmdLogs() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log("No log file yet. Start the daemon first.");
        return;
    }
    // Print last 50 lines using tail-read (reads only last 32KB, not entire file)
    const tailLines = readTailLines(LOG_FILE, 50);
    if (tailLines.length > 0) {
        process.stdout.write(tailLines.join("\n") + "\n");
    }
    // Follow mode: watch for changes and print new content
    let position = fs.statSync(LOG_FILE).size;
    const MAX_READ_CHUNK = 1024 * 1024; // 1MB cap per read to prevent OOM
    const watcher = fs.watch(LOG_FILE, () => {
        try {
            const stat = fs.statSync(LOG_FILE);
            if (stat.size < position) {
                // File was truncated (log rotation) — reset
                position = 0;
            }
            if (stat.size > position) {
                const readSize = Math.min(stat.size - position, MAX_READ_CHUNK);
                const fd = fs.openSync(LOG_FILE, "r");
                const buf = Buffer.alloc(readSize);
                fs.readSync(fd, buf, 0, readSize, position);
                fs.closeSync(fd);
                process.stdout.write(buf);
                position += readSize;
            }
        }
        catch (err) {
            console.error(`Log watch error: ${err.message}`);
        }
    });
    process.on("SIGINT", () => {
        watcher.close();
        process.exit(0);
    });
}
function getPlistPath() {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}
async function cmdInstallService() {
    if (process.platform !== "darwin" && process.platform !== "linux") {
        console.error("install-service is supported on macOS (launchd) and Linux (systemd).");
        process.exit(1);
    }
    if (process.platform === "linux" && !hasSystemd()) {
        console.error("systemd not detected. install-service requires systemd.");
        console.error("You can still run: elsa start (runs as a background process).");
        process.exit(1);
    }
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error("Not configured. Run: elsa setup");
        process.exit(1);
    }
    // Stop any manually-started daemon first to avoid conflict
    const existingPid = readPid();
    if (existingPid && isRunning(existingPid)) {
        process.kill(existingPid, "SIGTERM");
        fs.rmSync(PID_FILE, { force: true });
    }
    if (process.platform === "darwin") {
        await installLaunchdService();
    }
    else {
        await installSystemdService();
    }
}
async function installLaunchdService() {
    const [cmd, args] = DAEMON_CMD;
    const programArgs = [cmd, ...args];
    // Only PATH and HOME in the plist — secrets come from ~/.elsa/config.json at runtime
    const envEntries = [
        `    <key>PATH</key>\n    <string>${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}</string>`,
        `    <key>HOME</key>\n    <string>${os.homedir()}</string>`,
    ];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${programArgs.map((a) => `<string>${a}</string>`).join("\n    ")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>35</integer>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>
</dict>
</plist>`;
    const agentsDir = path.dirname(getPlistPath());
    fs.mkdirSync(agentsDir, { recursive: true });
    // Unload existing service if present (properly awaited for clean reinstall)
    if (fs.existsSync(getPlistPath())) {
        await launchctlExec(["unload", getPlistPath()]);
    }
    fs.writeFileSync(getPlistPath(), plist, { mode: 0o600 });
    const { code, stderr } = await launchctlExec(["load", getPlistPath()]);
    const loadFailed = code !== 0 || stderr.includes("Load failed");
    if (loadFailed) {
        console.error(`launchd: ${stderr.trim() || `exit code ${code}`}`);
        console.log("Starting daemon directly instead...");
        await startDirect();
        return;
    }
    const newPid = await waitForDaemon();
    if (newPid) {
        console.log("Service installed and started.");
        console.log(`Plist: ${getPlistPath()}`);
        console.log("The daemon will auto-restart on crash and start at login.");
    }
    else {
        console.error("Service installed but daemon did not start.");
        if (fs.existsSync(LOG_FILE)) {
            const lines = readTailLines(LOG_FILE, 5);
            if (lines.length > 0) {
                console.error("Recent logs:\n  " + lines.join("\n  "));
            }
        }
        else {
            console.error("No log file — daemon crashed before writing output.");
            console.error("Run manually to see errors:");
            console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
        }
        console.log("\nFalling back to direct start...");
        await launchctlExec(["unload", getPlistPath()]);
        await startDirect();
    }
}
async function installSystemdService() {
    const [cmd, args] = DAEMON_CMD;
    const execStart = [cmd, ...args].join(" ");
    const unit = `[Unit]
Description=Elsa - Telegram bridge for Claude Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
Environment=HOME=${os.homedir()}
Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}

[Install]
WantedBy=default.target
`;
    const serviceDir = path.dirname(getSystemdServicePath());
    fs.mkdirSync(serviceDir, { recursive: true });
    // Stop existing service if present (for clean reinstall)
    if (fs.existsSync(getSystemdServicePath())) {
        await systemctlExec(["stop", "elsa"]);
    }
    fs.writeFileSync(getSystemdServicePath(), unit, { mode: 0o644 });
    await systemctlExec(["daemon-reload"]);
    await systemctlExec(["enable", "elsa"]);
    const { code, stderr } = await systemctlExec(["start", "elsa"]);
    if (code !== 0) {
        console.error(`systemd: ${stderr.trim() || `exit code ${code}`}`);
        console.log("Starting daemon directly instead...");
        await startDirect();
        return;
    }
    const newPid = await waitForDaemon();
    if (newPid) {
        console.log("Service installed and started.");
        console.log(`Unit: ${getSystemdServicePath()}`);
        console.log("The daemon will auto-restart on crash and start at login.");
    }
    else {
        console.error("Service installed but daemon did not start.");
        if (fs.existsSync(LOG_FILE)) {
            const lines = readTailLines(LOG_FILE, 5);
            if (lines.length > 0) {
                console.error("Recent logs:\n  " + lines.join("\n  "));
            }
        }
        else {
            console.error("No log file — daemon crashed before writing output.");
            console.error("Run manually to see errors:");
            console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
        }
        console.log("\nFalling back to direct start...");
        await systemctlExec(["stop", "elsa"]);
        await startDirect();
    }
}
async function cmdUninstallService() {
    if (process.platform === "darwin") {
        if (!fs.existsSync(getPlistPath())) {
            console.log("Service not installed.");
            return;
        }
        await launchctlExec(["unload", getPlistPath()]);
        fs.rmSync(getPlistPath(), { force: true });
        console.log("Service uninstalled.");
        return;
    }
    if (process.platform === "linux") {
        if (!fs.existsSync(getSystemdServicePath())) {
            console.log("Service not installed.");
            return;
        }
        await systemctlExec(["stop", "elsa"]);
        await systemctlExec(["disable", "elsa"]);
        fs.rmSync(getSystemdServicePath(), { force: true });
        await systemctlExec(["daemon-reload"]);
        console.log("Service uninstalled.");
        return;
    }
    console.error("install-service is supported on macOS (launchd) and Linux (systemd).");
    process.exit(1);
}
function cmdHelp() {
    console.log(`
Elsa — Telegram & Discord bridge for Claude Code

Usage: elsa <command>

Commands:
  setup              Configure Telegram and/or Discord bot
  start              Start the daemon in the background
  stop               Stop the daemon
  status             Show whether the daemon is running
  logs               Tail the daemon logs (Ctrl+C to exit)
  install-service    Install as a system service (macOS launchd / Linux systemd)
  uninstall-service  Remove the system service
  help               Show this help message

Getting started:
  1. elsa setup        (choose Telegram, Discord, or both)
  2. elsa start
  3. Send a message to your bot
`);
}
const command = process.argv[2] ?? "help";
switch (command) {
    case "setup":
        cmdSetup().catch((err) => { console.error(err); process.exit(1); });
        break;
    case "start":
        cmdStart().catch((err) => { console.error(err); process.exit(1); });
        break;
    case "stop":
        cmdStop().catch((err) => { console.error(err); process.exit(1); });
        break;
    case "status":
        cmdStatus();
        break;
    case "logs":
        cmdLogs();
        break;
    case "install-service":
        cmdInstallService().catch((err) => { console.error(err); process.exit(1); });
        break;
    case "uninstall-service":
        cmdUninstallService().catch((err) => { console.error(err); process.exit(1); });
        break;
    default:
        cmdHelp();
}
