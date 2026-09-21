import type { SupportLog } from "./SupportBundle.js";

export type LogCorrelation = {
  commandId?: string;
  workspaceId?: string;
  threadId?: string;
  terminalId?: string;
  browserTabId?: string;
};

export class StructuredLogger {
  private readonly entries: SupportLog[] = [];
  private bytes = 0;

  constructor(
    private readonly maxEntries = 500,
    private readonly maxBytes = 256 * 1024,
  ) {}

  record(
    level: SupportLog["level"],
    message: string,
    correlation: LogCorrelation = {},
    context: Record<string, unknown> = {},
  ): void {
    const entry: SupportLog = {
      level,
      message,
      context: {
        ...correlation,
        ...context,
      },
      timestamp: new Date().toISOString(),
    };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    this.entries.push(entry);
    this.bytes += size;
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (removed) this.bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      else break;
    }
  }

  snapshot(): readonly SupportLog[] {
    return this.entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      ...(entry.context ? { context: { ...entry.context } } : {}),
    }));
  }

  clear(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }
}
