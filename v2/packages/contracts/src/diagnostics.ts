import { z } from "zod";

export const DiagnosticLog = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type DiagnosticLog = z.infer<typeof DiagnosticLog>;
