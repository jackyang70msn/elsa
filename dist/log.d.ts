export declare function logUser(text: string, tag?: string): void;
export declare function logStatus(status: string, tag?: string): void;
export declare function logStream(text: string, tag?: string): void;
export declare function logTool(toolName: string, detail?: string, tag?: string): void;
export declare function logApproval(toolName: string, result: "allow" | "always" | "deny", tag?: string): void;
export declare function logResult(tokens: number, turns: number, seconds: string, tag?: string): void;
export declare function logError(message: string, tag?: string): void;
