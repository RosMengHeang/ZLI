import { z } from "zod";

import { EnvironmentId, ProjectId, WorktreeId } from "./ids.js";
import { BrowserTabProjection } from "./browser.js";
import { ThreadProjection } from "./provider.js";
import { TerminalProjection } from "./terminal.js";

export const EnvironmentCapabilities = z.object({
  worktrees: z.boolean().optional(),
  terminals: z.boolean().optional(),
  browser: z.boolean().optional(),
  structuredProviders: z.boolean().optional(),
  eventReplay: z.boolean().optional(),
});
export type EnvironmentCapabilities = z.infer<typeof EnvironmentCapabilities>;

export const EnvironmentDescriptor = z.object({
  environmentId: EnvironmentId,
  label: z.string().min(1),
  protocolVersion: z.literal(1),
  capabilities: EnvironmentCapabilities,
});
export type EnvironmentDescriptor = z.infer<typeof EnvironmentDescriptor>;

export const ProjectProjection = z.object({
  projectId: ProjectId,
  path: z.string().min(1),
  name: z.string().min(1),
});
export type ProjectProjection = z.infer<typeof ProjectProjection>;

export const WorktreeProjection = z.object({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  path: z.string().min(1),
  branch: z.string().min(1),
  status: z.enum([
    "queued",
    "fetching",
    "creating",
    "bootstrapping",
    "ready",
    "failed",
    "cancelling",
    "cancelled",
  ]),
  errorMessage: z.string().min(1).optional(),
});
export type WorktreeProjection = z.infer<typeof WorktreeProjection>;

export const AttentionProjection = z.object({
  id: z.string().min(1),
  kind: z.enum(["approval", "user-input", "failure", "conflict"]),
  title: z.string().min(1),
});
export type AttentionProjection = z.infer<typeof AttentionProjection>;

export const RuntimeProjection = z.object({
  environment: EnvironmentDescriptor,
  projects: z.array(ProjectProjection),
  worktrees: z.array(WorktreeProjection),
  threads: z.array(ThreadProjection),
  terminals: z.array(TerminalProjection),
  browserTabs: z.array(BrowserTabProjection),
  attention: z.array(AttentionProjection),
  lastSequence: z.number().int().nonnegative(),
});
export type RuntimeProjection = z.infer<typeof RuntimeProjection>;
