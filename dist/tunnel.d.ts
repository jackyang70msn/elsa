export declare class TunnelManager {
    private tunnels;
    private authToken;
    private onAutoClose?;
    constructor(authToken?: string);
    setAuthToken(token: string | undefined): void;
    setAutoCloseCallback(cb: (chatId: number, port: number) => void): void;
    private createAutoCloseTimer;
    openTunnel(chatId: number, port: number): Promise<string>;
    resetTimer(chatId: number): void;
    closeTunnel(chatId: number): Promise<boolean>;
    hasTunnel(chatId: number): boolean;
    getTunnelInfo(chatId: number): {
        url: string;
        port: number;
    } | undefined;
    closeAll(): Promise<void>;
}
export declare function parsePort(input: string): number | null;
