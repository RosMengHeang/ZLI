import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, normalize, resolve } from "node:path";

import type {
  LegacyImportPreview,
  LegacyProjectImport,
  LegacySessionImport,
  LegacyWorktreeImport,
} from "@zli-v2/contracts";

export type LegacyScannerDependencies = {
  readText(path: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
};

export type LegacyScanResult = {
  preview: LegacyImportPreview;
};

export class LegacyScanError extends Error {
  constructor(readonly code: "unreadable_snapshot" | "invalid_snapshot", message: string) {
    super(message);
    this.name = "LegacyScanError";
  }
}

type JsonRecord = Record<string, unknown>;

const defaultDependencies: LegacyScannerDependencies = {
  readText: async (path) => readFile(path, "utf8"),
  pathExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

export class LegacyScanner {
  constructor(private readonly dependencies: LegacyScannerDependencies = defaultDependencies) {}

  async scan(snapshotPath: string, batchId: string): Promise<LegacyScanResult> {
    const resolvedPath = resolve(snapshotPath);
    let raw: string;
    try {
      raw = await this.dependencies.readText(resolvedPath);
    } catch (error) {
      throw new LegacyScanError("unreadable_snapshot", "Unable to read legacy snapshot.");
    }

    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new LegacyScanError("invalid_snapshot", "Legacy snapshot is not valid JSON.");
    }
    if (!isRecord(value)) {
      throw new LegacyScanError("invalid_snapshot", "Legacy snapshot must contain a JSON object.");
    }

    return { preview: await this.scanValue(value, resolvedPath, batchId) };
  }

  async scanValue(value: JsonRecord, snapshotPath: string, batchId: string): Promise<LegacyImportPreview> {
    const workspaceRegistry = isRecord(value.workspaceRegistry) ? value.workspaceRegistry : value;
    const workspaces = arrayOfRecords(workspaceRegistry.workspaces);
    const projects: LegacyProjectImport[] = [];
    const worktrees: LegacyWorktreeImport[] = [];
    const sessions: LegacySessionImport[] = [];
    const skipped: LegacyImportPreview["skipped"] = [];
    const conflicts: LegacyImportPreview["conflicts"] = [];
    const seenProjects = new Map<string, string>();
    const seenWorktrees = new Map<string, string>();

    for (let workspaceIndex = 0; workspaceIndex < workspaces.length; workspaceIndex += 1) {
      const workspace = workspaces[workspaceIndex]!;
      const project = isRecord(workspace.project) ? workspace.project : workspace;
      const projectPath = firstString(project.path, project.repositoryRoot, workspace.root);
      if (!projectPath || !isAbsolute(projectPath)) {
        skipped.push({
          recordId: "project:" + workspaceIndex,
          kind: "project",
          reason: "Project path is missing or not absolute.",
        });
        continue;
      }

      const projectRecordId = "project:" + workspaceIndex;
      const repositoryRoot = firstString(project.repositoryRoot, workspace.root, projectPath) ?? projectPath;
      const projectState = await this.recordState(projectPath, repositoryRoot);
      const projectEntry: LegacyProjectImport = {
        recordId: projectRecordId,
        name: firstString(project.name, basename(projectPath)) ?? "Legacy project",
        path: projectPath,
        repositoryRoot,
        state: projectState,
      };
      projects.push(projectEntry);
      const projectKey = canonicalPath(repositoryRoot);
      const previousProject = seenProjects.get(projectKey);
      if (previousProject) {
        projects[projects.length - 1] = { ...projectEntry, state: "duplicate" };
        conflicts.push({
          recordId: projectRecordId,
          kind: "project",
          reason: "Multiple legacy records resolve to the same repository root as " + previousProject + ".",
        });
      } else {
        seenProjects.set(projectKey, projectRecordId);
      }

      const agents = [
        ...arrayOfRecords(workspace.agents),
        ...arrayOfRecords(workspace.sessions),
        ...arrayOfRecords(workspace.worktrees),
      ];
      for (let agentIndex = 0; agentIndex < agents.length; agentIndex += 1) {
        const agent = agents[agentIndex]!;
        const recordBase = "legacy:" + workspaceIndex + ":" + agentIndex;
        const provider = firstString(agent.provider, agent.providerId);
        const name = firstString(agent.name, provider);
        if (!provider || !name) {
          skipped.push({ recordId: "session:" + recordBase, kind: "session", reason: "Provider or session name is missing." });
          continue;
        }
        sessions.push({
          recordId: "session:" + recordBase,
          projectRecordId,
          name,
          provider,
          resume: resumeState(agent, provider),
        });

        const worktreePath = firstString(agent.worktreePath);
        if (!worktreePath) continue;
        const branch = firstString(agent.branch, name.replace(/[^a-zA-Z0-9._/-]/gu, "-")) ?? "legacy-import";
        if (!isAbsolute(worktreePath)) {
          skipped.push({ recordId: "worktree:" + recordBase, kind: "worktree", reason: "Worktree path is not absolute." });
          continue;
        }
        const cwd = firstString(agent.cwd);
        const state = cwd && isAbsolute(cwd) ? await this.recordState(worktreePath, cwd) : await this.recordState(worktreePath, "");
        const worktreeEntry: LegacyWorktreeImport = {
          recordId: "worktree:" + recordBase,
          projectRecordId,
          path: worktreePath,
          branch,
          state,
        };
        worktrees.push(worktreeEntry);
        const worktreeKey = canonicalPath(worktreePath);
        const previousWorktree = seenWorktrees.get(worktreeKey);
        if (previousWorktree) {
          worktrees[worktrees.length - 1] = { ...worktreeEntry, state: "duplicate" };
          conflicts.push({
            recordId: worktreeEntry.recordId,
            kind: "worktree",
            reason: "Multiple legacy records resolve to the same worktree path as " + previousWorktree + ".",
          });
        } else {
          seenWorktrees.set(worktreeKey, worktreeEntry.recordId);
        }
      }
    }

    return {
      batchId,
      snapshotPath,
      projects,
      worktrees,
      sessions,
      skipped,
      conflicts,
    };
  }

  private async recordState(path: string, fallbackPath: string): Promise<"ready" | "missing" | "moved"> {
    if (await this.dependencies.pathExists(path)) return "ready";
    if (path !== fallbackPath && await this.dependencies.pathExists(fallbackPath)) return "moved";
    return "missing";
  }
}

function resumeState(agent: JsonRecord, provider: string): "exact" | "unsupported" | "unknown" {
  const resume = isRecord(agent.resume) ? agent.resume : undefined;
  if (agent.resumeAvailability === "available" || resume?.type === "available") return "exact";
  if (agent.resumeAvailability === "unsupported" || resume?.type === "unsupported") return "unsupported";
  if (provider === "codex" && (typeof agent.resumeId === "string" || typeof agent.sessionId === "string")) return "exact";
  return "unknown";
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  const value = normalize(resolve(path));
  return process.platform === "win32" ? value.toLowerCase() : value;
}
