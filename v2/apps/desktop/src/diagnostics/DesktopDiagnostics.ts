import type { DesktopAppInfo, DiagnosticLog } from "@zli-v2/contracts";

export class DesktopDiagnostics {
  /** Which build produced the logs, for the support bundle. */
  readonly app: DesktopAppInfo | undefined;
  private readonly entries: DiagnosticLog[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(options: { maxEntries?: number; maxBytes?: number; app?: DesktopAppInfo } = {}) {
    this.maxEntries = options.maxEntries ?? 250;
    this.maxBytes = options.maxBytes ?? 128 * 1024;
    this.app = options.app ? { ...options.app } : undefined;
  }

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
