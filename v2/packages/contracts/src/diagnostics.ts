import { z } from "zod";

export const DiagnosticLog = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type DiagnosticLog = z.infer<typeof DiagnosticLog>;

/** The desktop build a support bundle came from. */
export const DesktopAppInfo = z.object({
  version: z.string().min(1).max(64),
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
  electron: z.string().min(1).max(64).optional(),
  packaged: z.boolean().optional(),
});
export type DesktopAppInfo = z.infer<typeof DesktopAppInfo>;
