import ngrok from "@ngrok/ngrok";
const AUTO_CLOSE_MS = 30 * 60 * 1000; // 30 minutes
export class TunnelManager {
    tunnels = new Map();
    authToken;
    onAutoClose;
    constructor(authToken) {
        this.authToken = authToken;
    }
    setAuthToken(token) {
        this.authToken = token;
    }
    setAutoCloseCallback(cb) {
        this.onAutoClose = cb;
    }
    createAutoCloseTimer(chatId) {
        return setTimeout(() => {
            const entry = this.tunnels.get(chatId);
            if (entry) {
                this.closeTunnel(chatId).catch(() => { });
                this.onAutoClose?.(chatId, entry.port);
            }
        }, AUTO_CLOSE_MS);
    }
    async openTunnel(chatId, port) {
        if (!this.authToken) {
            throw new Error("No ngrok token configured. Run `elsa setup` or set NGROK_AUTH_TOKEN environment variable.");
        }
        // Close existing tunnel for this chat
        await this.closeTunnel(chatId);
        const listener = await ngrok.forward({
            addr: port,
            authtoken: this.authToken,
        });
        const url = listener.url();
        if (!url) {
            throw new Error("Failed to get tunnel URL from ngrok.");
        }
        const timer = this.createAutoCloseTimer(chatId);
        this.tunnels.set(chatId, { url, port, listener, timer });
        return url;
    }
    resetTimer(chatId) {
        const entry = this.tunnels.get(chatId);
        if (!entry)
            return;
        clearTimeout(entry.timer);
        entry.timer = this.createAutoCloseTimer(chatId);
    }
    async closeTunnel(chatId) {
        const entry = this.tunnels.get(chatId);
        if (!entry)
            return false;
        clearTimeout(entry.timer);
        try {
            await entry.listener.close();
        }
        catch { }
        this.tunnels.delete(chatId);
        return true;
    }
    hasTunnel(chatId) {
        return this.tunnels.has(chatId);
    }
    getTunnelInfo(chatId) {
        const entry = this.tunnels.get(chatId);
        if (!entry)
            return undefined;
        return { url: entry.url, port: entry.port };
    }
    async closeAll() {
        const chatIds = [...this.tunnels.keys()];
        for (const chatId of chatIds) {
            await this.closeTunnel(chatId);
        }
    }
}
export function parsePort(input) {
    // Try plain number: "3000"
    const num = Number(input);
    if (!isNaN(num) && num > 0 && num <= 65535 && String(Math.floor(num)) === input) {
        return num;
    }
    // Try URL-like: "localhost:3000", "http://localhost:3000", "http://localhost:3000/dashboard"
    try {
        let urlStr = input;
        if (!urlStr.includes("://")) {
            urlStr = `http://${urlStr}`;
        }
        const url = new URL(urlStr);
        const port = Number(url.port);
        if (port > 0 && port <= 65535)
            return port;
    }
    catch { }
    return null;
}
