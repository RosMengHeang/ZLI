import { z } from "zod";

const LegacyRecordState = z.enum(["ready", "missing", "moved", "duplicate"]);
const LegacyResumeState = z.enum(["exact", "unsupported", "unknown"]);

export const LegacyProjectImport = z.object({
  recordId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  repositoryRoot: z.string().min(1),
  state: LegacyRecordState,
});
export type LegacyProjectImport = z.infer<typeof LegacyProjectImport>;

export const LegacyWorktreeImport = z.object({
  recordId: z.string().min(1),
  projectRecordId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  state: LegacyRecordState,
});
export type LegacyWorktreeImport = z.infer<typeof LegacyWorktreeImport>;

export const LegacySessionImport = z.object({
  recordId: z.string().min(1),
  projectRecordId: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  resume: LegacyResumeState,
});
export type LegacySessionImport = z.infer<typeof LegacySessionImport>;

export const LegacyIssue = z.object({
  recordId: z.string().min(1),
  kind: z.enum(["project", "worktree", "session", "snapshot"]),
  reason: z.string().min(1),
});
export type LegacyIssue = z.infer<typeof LegacyIssue>;

export const LegacyImportPreview = z.object({
  batchId: z.string().min(1),
  snapshotPath: z.string().min(1),
  projects: z.array(LegacyProjectImport),
  worktrees: z.array(LegacyWorktreeImport),
  sessions: z.array(LegacySessionImport),
  skipped: z.array(LegacyIssue),
  conflicts: z.array(LegacyIssue),
});
export type LegacyImportPreview = z.infer<typeof LegacyImportPreview>;

export const LegacyImportProjection = z.object({
  status: z.enum(["idle", "scanning", "ready", "importing", "imported", "rolled-back", "failed"]),
  preview: LegacyImportPreview.optional(),
  batchId: z.string().min(1).optional(),
  importedProjectIds: z.array(z.string().min(1)),
  importedWorktreeIds: z.array(z.string().min(1)),
  error: z.string().min(1).optional(),
});
export type LegacyImportProjection = z.infer<typeof LegacyImportProjection>;
