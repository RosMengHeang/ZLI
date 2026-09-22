import { createHash, randomUUID } from "node:crypto";

import {
  CommandId,
  ProjectId,
  WorktreeId,
  type LegacyImportPreview,
  type RuntimeCommand,
} from "@zli-v2/contracts";

import { Engine } from "../orchestration/Engine.js";

export type LegacyImportResult = {
  importedProjectIds: string[];
  importedWorktreeIds: string[];
};

export class LegacyImporter {
  constructor(private readonly engine: Engine) {}

  async import(preview: LegacyImportPreview, selectedRecordIds: readonly string[]): Promise<LegacyImportResult> {
    const selected = new Set(selectedRecordIds);
    const importedProjectIds: string[] = [];
    const importedWorktreeIds: string[] = [];
    try {
      const projectRecords = preview.projects.filter((project) =>
        project.state === "ready" &&
        (selected.has(project.recordId) || preview.worktrees.some((worktree) => worktree.projectRecordId === project.recordId && selected.has(worktree.recordId))),
      );
      const projectIds = new Map<string, string>();

      for (const project of projectRecords) {
        const receipt = await this.dispatch({
          type: "project.register",
          path: project.path,
        });
        if (receipt.status === "accepted" && receipt.result?.projectId) {
          importedProjectIds.push(receipt.result.projectId);
          projectIds.set(project.recordId, receipt.result.projectId);
          continue;
        }
        if (receipt.error?.code !== "project_exists") throw new Error(receipt.error?.message ?? "Project import failed.");
        const existing = await this.engine.projection();
        const match = existing.projects.find((candidate) => canonicalPath(candidate.path) === canonicalPath(project.path));
        if (!match) throw new Error("Existing project could not be resolved during import.");
        projectIds.set(project.recordId, match.projectId);
      }

      for (const worktree of preview.worktrees) {
        if (!selected.has(worktree.recordId) || worktree.state !== "ready") continue;
        const projectId = projectIds.get(worktree.projectRecordId);
        if (!projectId) continue;
        const worktreeId = stableWorktreeId(preview.batchId, worktree.recordId);
        const receipt = await this.dispatch({
          type: "worktree.import",
          worktreeId: WorktreeId.parse(worktreeId),
          projectId: ProjectId.parse(projectId),
          path: worktree.path,
          branch: worktree.branch,
        });
        if (receipt.status === "accepted") {
          importedWorktreeIds.push(worktreeId);
        } else if (receipt.error?.code !== "worktree_exists") {
          throw new Error(receipt.error?.message ?? "Worktree import failed.");
        }
      }

      return { importedProjectIds, importedWorktreeIds };
    } catch (error) {
      try {
        await this.rollback({ importedProjectIds, importedWorktreeIds });
      } catch {
        // Preserve the import error; the caller records it as a failed batch.
      }
      throw error;
    }
  }

  async rollback(result: LegacyImportResult): Promise<void> {
    for (const worktreeId of [...result.importedWorktreeIds].reverse()) {
      await this.dispatch({ type: "worktree.archived", worktreeId: WorktreeId.parse(worktreeId) });
    }
    for (const projectId of [...result.importedProjectIds].reverse()) {
      await this.dispatch({ type: "project.archive", projectId: ProjectId.parse(projectId) });
    }
  }

  private dispatch(command: RuntimeCommand): ReturnType<Engine["dispatchPromise"]> {
    return this.engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse(randomUUID()),
      command,
    });
  }
}

function stableWorktreeId(batchId: string, recordId: string): string {
  const bytes = createHash("sha256").update("zli-legacy-worktree:" + batchId + ":" + recordId).digest("hex").slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = ((Number.parseInt(bytes[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function canonicalPath(path: string): string {
  const normalized = path.replaceAll("/", "\\");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
