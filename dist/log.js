const isTTY = process.stdout.isTTY ?? false;
const RESET = isTTY ? "\x1b[0m" : "";
const DIM = isTTY ? "\x1b[2m" : "";
const CYAN = isTTY ? "\x1b[36m" : "";
const GREEN = isTTY ? "\x1b[32m" : "";
const YELLOW = isTTY ? "\x1b[33m" : "";
const RED = isTTY ? "\x1b[31m" : "";
const MAGENTA = isTTY ? "\x1b[35m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
function ts() {
    return DIM + new Date().toLocaleTimeString("en-GB", { hour12: false }) + RESET;
}
function prefix(tag) {
    return tag ? `${DIM}[${tag}]${RESET} ` : "";
}
function jsonLog(level, message, extra) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        message,
        ...extra,
    };
    console.log(JSON.stringify(entry));
}
export function logUser(text, tag) {
    if (!isTTY) {
        jsonLog("info", text, { type: "user", bot: tag });
        return;
    }
    const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
    console.log(`${ts()} ${prefix(tag)}${BOLD}${CYAN}YOU${RESET}  ${preview}`);
}
export function logStatus(status, tag) {
    if (!isTTY) {
        jsonLog("debug", status, { type: "status", bot: tag });
        return;
    }
    console.log(`${ts()} ${prefix(tag)}${DIM}${MAGENTA}...${RESET}  ${DIM}${status}${RESET}`);
}
export function logStream(text, tag) {
    if (!isTTY) {
        jsonLog("info", text, { type: "response", bot: tag });
        return;
    }
    const preview = text.length > 300 ? text.slice(0, 300) + "..." : text;
    console.log(`${ts()} ${prefix(tag)}${GREEN}Claude${RESET}  ${preview}`);
}
export function logTool(toolName, detail, tag) {
    if (!isTTY) {
        jsonLog("info", toolName, { type: "tool", detail, bot: tag });
        return;
    }
    const suffix = detail ? ` ${DIM}${detail}${RESET}` : "";
    console.log(`${ts()} ${prefix(tag)}${YELLOW}TOOL${RESET}  ${toolName}${suffix}`);
}
export function logApproval(toolName, result, tag) {
    if (!isTTY) {
        jsonLog("info", toolName, { type: "approval", result, bot: tag });
        return;
    }
    const label = result === "allow" ? `${GREEN}APPROVED${RESET}` :
        result === "always" ? `${GREEN}ALWAYS${RESET}  ` :
            `${RED}DENIED${RESET}  `;
    console.log(`${ts()} ${prefix(tag)}${label}  ${toolName}`);
}
export function logResult(tokens, turns, seconds, tag) {
    if (!isTTY) {
        jsonLog("info", "query complete", { type: "result", tokens, turns, seconds, bot: tag });
        return;
    }
    console.log(`${ts()} ${prefix(tag)}${DIM}DONE${RESET}  ${tokens.toLocaleString()} tokens | ${turns} turns | ${seconds}s`);
}
export function logError(message, tag) {
    if (!isTTY) {
        jsonLog("error", message, { type: "error", bot: tag });
        return;
    }
    console.log(`${ts()} ${prefix(tag)}${RED}ERROR${RESET}  ${message}`);
}
