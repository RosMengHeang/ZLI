import type { DiagnosticLog } from "@zli-v2/contracts";

export class DesktopDiagnostics {
  private readonly entries: DiagnosticLog[] = [];
  private bytes = 0;

  constructor(
    private readonly maxEntries = 250,
    private readonly maxBytes = 128 * 1024,
  ) {}

  record(level: DiagnosticLog["level"], message: string, context: Record<string, unknown> = {}): void {
    const entry: DiagnosticLog = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
    };
    this.entries.push(entry);
    this.bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (removed) this.bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      else break;
    }
  }

  snapshot(): readonly DiagnosticLog[] {
    return this.entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      ...(entry.context ? { context: { ...entry.context } } : {}),
    }));
  }
}
