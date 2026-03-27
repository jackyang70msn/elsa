export interface Schedule {
    id: string;
    botId: number;
    chatId: number;
    prompt: string;
    cronExpr: string;
    humanLabel: string;
    createdAt: string;
    lastRunAt: string | null;
    platform?: "telegram" | "discord";
    channelId?: string;
    once?: boolean;
}
export type ScheduleRunCallback = (schedule: Schedule) => Promise<void>;
export declare function loadSchedules(): Schedule[];
export declare class ScheduleManager {
    private tasks;
    private runCallback;
    constructor(runCallback: ScheduleRunCallback);
    start(schedules: Schedule[]): void;
    private startTask;
    add(schedule: Schedule): void;
    remove(scheduleId: string): boolean;
    removeAllForBot(botId: number): void;
    getForBot(botId: number): Schedule[];
    getAll(): Schedule[];
    stop(): void;
}
export declare function parseScheduleWithClaude(input: string): Promise<{
    cronExpr: string;
    humanLabel: string;
    prompt: string;
    once?: boolean;
} | null>;
export declare function generateScheduleId(): string;
