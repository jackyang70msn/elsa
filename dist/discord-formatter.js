/**
 * Discord Markdown formatter for Elsa.
 *
 * Claude outputs standard Markdown.  Discord supports most of it natively,
 * so the conversion is intentionally lightweight compared to the Telegram
 * HTML formatter in formatter.ts.
 */
// ---------------------------------------------------------------------------
// claudeToDiscord — convert Claude Markdown → Discord Markdown
// ---------------------------------------------------------------------------
export function claudeToDiscord(markdown) {
    // Split by fenced code blocks so we don't touch anything inside them
    const parts = markdown.split(/(```[\s\S]*?```)/g);
    let result = "";
    for (const part of parts) {
        if (part.startsWith("```")) {
            // Code blocks pass through unchanged — Discord renders them natively
            result += part;
        }
        else {
            let text = part;
            // Convert headings to bold (same visual strategy as Telegram formatter)
            text = text.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
            // Unescape HTML entities that Claude might emit
            text = unescapeHtml(text);
            result += text;
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// unescapeHtml — reverse common HTML entities back to raw characters
// ---------------------------------------------------------------------------
function unescapeHtml(text) {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}
// ---------------------------------------------------------------------------
// splitDiscordMessage — split a message so every part ≤ maxLen (default 2000)
// ---------------------------------------------------------------------------
export function splitDiscordMessage(text, maxLen = 2000) {
    if (text.length <= maxLen)
        return [text];
    const messages = [];
    let remaining = text;
    // We reserve space for a possible closing ``` + newline (4 chars)
    const FENCE_RESERVE = 4;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            messages.push(remaining);
            break;
        }
        const effectiveLimit = maxLen - FENCE_RESERVE;
        // --- Determine if we are currently inside a code block ---
        const insideCodeBlock = isInsideCodeFence(remaining, effectiveLimit);
        // Try to find a good split point
        let splitIdx = -1;
        if (!insideCodeBlock) {
            // Prefer paragraph boundary
            splitIdx = remaining.lastIndexOf("\n\n", effectiveLimit);
            if (splitIdx < effectiveLimit * 0.3) {
                splitIdx = remaining.lastIndexOf("\n", effectiveLimit);
            }
            // Avoid splitting inside inline code
            if (splitIdx > 0 && isInsideInlineCode(remaining, splitIdx)) {
                // Back up to before the backtick
                const tick = remaining.lastIndexOf("`", splitIdx);
                if (tick > 0)
                    splitIdx = tick;
            }
            if (splitIdx < effectiveLimit * 0.3) {
                splitIdx = effectiveLimit;
            }
        }
        else {
            // We're inside a code block — try to split at a newline
            splitIdx = remaining.lastIndexOf("\n", effectiveLimit);
            if (splitIdx < effectiveLimit * 0.3) {
                splitIdx = effectiveLimit;
            }
        }
        let chunk = remaining.slice(0, splitIdx);
        remaining = remaining.slice(splitIdx);
        if (insideCodeBlock) {
            // Find which language tag was used for the opening fence
            const lang = detectCodeFenceLang(chunk);
            // Close the block in this chunk
            chunk += "\n```";
            // Re-open in the next chunk
            remaining = "```" + lang + "\n" + remaining.trimStart();
        }
        else {
            remaining = remaining.trimStart();
        }
        messages.push(chunk);
    }
    return messages;
}
// ---------------------------------------------------------------------------
// helpers for splitDiscordMessage
// ---------------------------------------------------------------------------
/**
 * Determine whether the position `pos` falls inside a fenced code block
 * in `text`.  We simply count opening/closing ``` fences before `pos`.
 */
function isInsideCodeFence(text, pos) {
    const slice = text.slice(0, pos);
    const fences = slice.match(/^```/gm);
    // Odd number of fences means we're inside an open block
    return fences !== null && fences.length % 2 === 1;
}
/**
 * Detect the language tag from the most recent opening ``` fence in `chunk`.
 */
function detectCodeFenceLang(chunk) {
    const matches = [...chunk.matchAll(/^```(\w*)/gm)];
    if (matches.length === 0)
        return "";
    // The last opening fence's language
    return matches[matches.length - 1][1];
}
/**
 * Check whether position `pos` falls inside an inline code span
 * (single backtick pair, not a fence).
 */
function isInsideInlineCode(text, pos) {
    const before = text.slice(0, pos);
    // Count single backticks that are NOT part of ``` fences
    let inCode = false;
    for (let i = 0; i < before.length; i++) {
        if (before[i] === "`") {
            // Skip triple backticks (fenced code blocks)
            if (before.slice(i, i + 3) === "```") {
                // Jump past the entire fenced block
                const closeIdx = before.indexOf("```", i + 3);
                if (closeIdx !== -1) {
                    i = closeIdx + 2; // will be incremented by loop
                }
                else {
                    break; // unclosed fence — rest is inside block
                }
            }
            else {
                inCode = !inCode;
            }
        }
    }
    return inCode;
}
// ---------------------------------------------------------------------------
// formatToolCallDiscord — render a Claude tool call as Discord Markdown
// ---------------------------------------------------------------------------
export function formatToolCallDiscord(toolName, input) {
    const inp = input;
    switch (toolName) {
        case "Bash":
            return (`**Bash Command**\n` +
                `\`\`\`bash\n${inp.command || ""}\n\`\`\``);
        case "Edit":
            return (`**Edit File**: \`${inp.file_path || ""}\`\n` +
                `Old:\n\`\`\`\n${(inp.old_string || "").slice(0, 300)}\n\`\`\`\n` +
                `New:\n\`\`\`\n${(inp.new_string || "").slice(0, 300)}\n\`\`\``);
        case "Write":
            return (`**Write File**: \`${inp.file_path || ""}\`\n` +
                `\`\`\`\n${(inp.content || "").slice(0, 500)}\n\`\`\``);
        case "NotebookEdit":
            return (`**Notebook Edit**: \`${inp.notebook_path || ""}\`\n` +
                `\`\`\`\n${(inp.new_source || "").slice(0, 500)}\n\`\`\``);
        default:
            return (`**${toolName}**\n` +
                `\`\`\`json\n${JSON.stringify(input, null, 2).slice(0, 500)}\n\`\`\``);
    }
}
