import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { execFile } from "node:child_process";
import { DATA_DIR } from "./config.js";
import { resolveClaudePath } from "./store.js";
const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");
// --- Persistence ---
export function loadSchedules() {
    try {
        if (!fs.existsSync(SCHEDULES_FILE))
            return [];
        return JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf-8"));
    }
    catch {
        return [];
    }
}
function saveSchedules(schedules) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), { mode: 0o600 });
}
// --- Schedule Manager ---
export class ScheduleManager {
    tasks = new Map();
    runCallback;
    constructor(runCallback) {
        this.runCallback = runCallback;
    }
    start(schedules) {
        for (const schedule of schedules) {
            this.startTask(schedule);
        }
        if (schedules.length > 0) {
            console.log(`Loaded ${schedules.length} scheduled task(s)`);
        }
    }
    startTask(schedule) {
        if (!cron.validate(schedule.cronExpr)) {
            console.error(`[scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cronExpr}`);
            return;
        }
        const task = cron.schedule(schedule.cronExpr, async () => {
            try {
                console.log(`[scheduler] Running: ${schedule.humanLabel} (${schedule.id})`);
                // Update lastRunAt
                const schedules = loadSchedules();
                const idx = schedules.findIndex((s) => s.id === schedule.id);
                if (idx !== -1) {
                    schedules[idx].lastRunAt = new Date().toISOString();
                    saveSchedules(schedules);
                }
                await this.runCallback(schedule);
                if (schedule.once) {
                    console.log(`[scheduler] One-time task done, removing: ${schedule.id}`);
                    this.remove(schedule.id);
                }
            }
            catch (err) {
                console.error(`[scheduler] Task ${schedule.id} failed:`, err);
            }
        });
        this.tasks.set(schedule.id, task);
    }
    add(schedule) {
        const schedules = loadSchedules().filter((s) => s.id !== schedule.id);
        schedules.push(schedule);
        saveSchedules(schedules);
        this.startTask(schedule);
    }
    remove(scheduleId) {
        const task = this.tasks.get(scheduleId);
        if (!task)
            return false;
        task.stop();
        this.tasks.delete(scheduleId);
        const schedules = loadSchedules().filter((s) => s.id !== scheduleId);
        saveSchedules(schedules);
        return true;
    }
    removeAllForBot(botId) {
        const schedules = loadSchedules().filter((s) => s.botId === botId);
        for (const s of schedules) {
            this.remove(s.id);
        }
    }
    getForBot(botId) {
        return loadSchedules().filter((s) => s.botId === botId);
    }
    getAll() {
        return loadSchedules();
    }
    stop() {
        for (const [, task] of this.tasks) {
            task.stop();
        }
        this.tasks.clear();
    }
}
// --- Claude-powered schedule parsing (via Claude Code SDK) ---
export async function parseScheduleWithClaude(input) {
    const prompt = `Parse this schedule request and return ONLY valid JSON with no explanation or markdown:\n` +
        `{"cronExpr": "...", "humanLabel": "...", "prompt": "...", "once": false}\n\n` +
        `Rules:\n` +
        `- cronExpr: standard 5-field cron expression that best matches the requested time\n` +
        `- humanLabel: short human-readable label in the SAME LANGUAGE as the input, e.g. "每天早上 9 點", "每週一早上 9 點", "每 3 天一次". If input is English, use English.\n` +
        `- prompt: rewrite the task as a clear, precise, actionable instruction for an AI agent running autonomously with no human present. Use the SAME LANGUAGE as the input.\n` +
        `- once: set to true if the user wants a ONE-TIME task (e.g. "today at 3pm", "in 30 minutes", "tomorrow 9am", "今天下午3點", "明天早上9點"). Set to false for recurring tasks (e.g. "every day", "daily", "weekly", "每天", "每週").\n\n` +
        `Input: "${input.replace(/"/g, '\\"')}"`;
    try {
        // Strip CLAUDECODE env var so CLI subprocess doesn't refuse to start
        const { CLAUDECODE: _, ...cleanEnv } = process.env;
        const resultText = await new Promise((resolve, reject) => {
            const child = execFile(resolveClaudePath(), [
                "--print",
                "--output-format", "json",
                "--model", "claude-haiku-4-5-20251001",
                "--max-turns", "1",
                "--dangerously-skip-permissions",
            ], {
                env: cleanEnv,
                timeout: 60_000,
            }, (err, stdout) => {
                if (err)
                    return reject(err);
                resolve(stdout);
            });
            // Pass prompt via stdin to avoid shell escaping issues on Windows
            child.stdin?.write(prompt);
            child.stdin?.end();
        });
        if (!resultText) {
            console.error("[scheduler] No result from Claude CLI");
            return null;
        }
        // CLI --output-format json returns a JSON object with a .result field
        let text = resultText;
        try {
            const parsed = JSON.parse(resultText);
            if (typeof parsed.result === "string")
                text = parsed.result;
        }
        catch {
            // stdout may be plain text — use as-is
        }
        // Extract JSON from response (may be wrapped in markdown code fences)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("[scheduler] No JSON found in response:", text);
            return null;
        }
        return JSON.parse(jsonMatch[0]);
    }
    catch (err) {
        console.error("[scheduler] Parse error:", err);
        return null;
    }
}
export function generateScheduleId() {
    return `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
