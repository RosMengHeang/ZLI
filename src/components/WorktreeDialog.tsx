import { useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { toAppError } from "../lib/errors";
import { gitAuditWorktrees, gitPruneWorktrees, gitRemoveWorktree, gitStatus } from "../tauri/git";
import { sessionClient, type ReconcileReport } from "../tauri/sessions";
import type { GitStatus, WorktreeAudit, WorktreeAuditEntry } from "../types";
import { workspaceRootKey } from "../lib/workspaceRegistry";

function pathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function worktreesForAudit(report: WorktreeAudit): WorktreeAuditEntry[] {
  return report.entries.filter(
    (entry) =>
      entry.state !== "main" &&
      (entry.branch?.startsWith("swarm/") || entry.state.startsWith("orphaned_") || entry.state === "prunable_metadata"),
  );
}

export function WorktreeDialog() {
  const open = useUiStore((state) => state.worktreeOpen);
  const setOpen = useUiStore((state) => state.setWorktreeOpen);
  const worktreeProjectRoot = useUiStore((state) => state.worktreeProjectRoot);
  const project = useProjectStore((state) => state.project);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const agents = useAgentStore((state) => state.agents);
  const targetProject = worktreeProjectRoot
    ? workspaces.find((workspace) => workspaceRootKey(workspace.project.repositoryRoot) === workspaceRootKey(worktreeProjectRoot))?.project
    : project;
  const repositoryRoot = targetProject?.repositoryRoot;
  const [audit, setAudit] = useState<WorktreeAudit | null>(null);
  const [statuses, setStatuses] = useState<Record<string, GitStatus | null>>({});
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runtimeReport, setRuntimeReport] = useState<ReconcileReport | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const activePaths = new Set(
    Object.values(agents)
      .map((agent) => agent.worktreePath)
      .filter((path): path is string => Boolean(path))
      .map(pathKey),
  );

  const worktrees = (audit?.entries ?? []).filter(
    (entry) =>
      entry.state !== "main" &&
      (entry.branch?.startsWith("swarm/") || entry.state.startsWith("orphaned_") || entry.state === "prunable_metadata"),
  );

  const loadWorktrees = useCallback(async () => {
    if (!repositoryRoot) return;
    setLoading(true);
    setError(null);
    setPendingPath(null);
    setTyped("");
    try {
      const report = await gitAuditWorktrees(repositoryRoot);
      setAudit(report);
      const entries = await Promise.all(
        worktreesForAudit(report).map(async (worktree) => {
          if (worktree.state.startsWith("orphaned_") || worktree.state === "prunable_metadata") {
            return [worktree.path, null] as const;
          }
          try {
            return [worktree.path, await gitStatus(worktree.path)] as const;
          } catch {
            return [worktree.path, null] as const;
          }
        }),
      );
      setStatuses(Object.fromEntries(entries));
    } catch (caught) {
      setAudit(null);
      setError(toAppError(caught).message);
    } finally {
      setLoading(false);
    }
  }, [repositoryRoot]);

  const loadRuntime = useCallback(async () => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      setRuntimeReport(await sessionClient.reconcile());
    } catch (caught) {
      setRuntimeReport(null);
      setRuntimeError(toAppError(caught).message);
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void loadWorktrees();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRuntime, loadWorktrees, open]);

  function requestForce(worktree: WorktreeAuditEntry) {
    if (activePaths.has(pathKey(worktree.path))) return;
    setPendingPath(worktree.path);
    setTyped("");
    setError(null);
  }

  async function removeWorktree(worktree: WorktreeAuditEntry, force: boolean) {
    if (!repositoryRoot || activePaths.has(pathKey(worktree.path))) return;
    setBusyPath(worktree.path);
    setError(null);
    try {
      await gitRemoveWorktree({
        repositoryRoot,
        worktreePath: worktree.path,
        force,
      });
      await loadWorktrees();
    } catch (caught) {
      setPendingPath(worktree.path);
      setTyped("");
      setError(toAppError(caught).message);
    } finally {
      setBusyPath(null);
    }
  }

  async function pruneMissingRecords() {
    if (!repositoryRoot) return;
    setLoading(true);
    setError(null);
    try {
      await gitPruneWorktrees(repositoryRoot);
      await loadWorktrees();
    } catch (caught) {
      setError(toAppError(caught).message);
      setLoading(false);
    }
  }

  const missingCount = worktrees.filter((worktree) => worktree.state === "prunable_metadata").length;

  return (
    <Modal
      title="Workspace cleanup"
      open={open}
      busy={loading || runtimeLoading || Boolean(busyPath)}
      onClose={() => setOpen(false)}
      width={620}
      description="Review runtime sessions and old agent checkouts before reclaiming disk space."
    >
      {!targetProject ? (
        <p className="text-[13px] text-mute">Open a project to manage its worktrees.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <section className="rounded-md border border-line bg-raised p-3" aria-label="Runtime cleanup">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-paper">Runtime cleanup</div>
                <p className="mt-1 max-w-[29rem] text-[11px] leading-4 text-mute">
                  Reconcile ZLI-owned sessions and processes before removing old checkouts. Only matching ZLI ownership records can be stopped.
                </p>
              </div>
              <Button type="button" size="sm" variant="ghost" disabled={runtimeLoading} onClick={() => void loadRuntime()}>
                {runtimeLoading ? "Checking…" : "Reconcile runtime"}
              </Button>
            </div>
            {runtimeError ? <div className="mt-3 banner banner-error" role="alert">{runtimeError}</div> : null}
            {runtimeReport ? (
              <div className="mt-3 border-t border-line pt-3">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-mute">
                  <span>{runtimeReport.offlineSessionIds.length} offline session{runtimeReport.offlineSessionIds.length === 1 ? "" : "s"}</span>
                  <span>{runtimeReport.stoppedOwnedProcessIds.length} owned process{runtimeReport.stoppedOwnedProcessIds.length === 1 ? "" : "es"} stopped</span>
                  <span>{runtimeReport.retainedMissingWorktrees.length} missing checkout{runtimeReport.retainedMissingWorktrees.length === 1 ? "" : "s"} retained</span>
                </div>
                {runtimeReport.unknownProcessIds.length ? (
                  <p className="mt-2 text-[11px] leading-4 text-warn">
                    {runtimeReport.unknownProcessIds.length} unknown process{runtimeReport.unknownProcessIds.length === 1 ? "" : "es"} left untouched for review.
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] leading-4 text-mute">No unknown processes were changed.</p>
                )}
              </div>
            ) : null}
          </section>

          <div className="flex items-center justify-between text-[12px] text-mute">
            <span>{worktrees.length} agent checkout{worktrees.length === 1 ? "" : "s"}</span>
            <span>Separate files are where most disk space goes.</span>
          </div>

          {error ? <div className="banner banner-error" role="alert">{error}</div> : null}

          {!worktrees.length && !loading ? (
            <div className="rounded-md border border-line bg-raised px-3 py-4 text-[13px] text-mute">
              No ZLI worktrees found for this project.
            </div>
          ) : (
            <div className="flex max-h-[min(48vh,28rem)] flex-col gap-2 overflow-y-auto pr-1">
              {worktrees.map((worktree) => {
                const active = activePaths.has(pathKey(worktree.path));
                const status = statuses[worktree.path];
                const dirty = worktree.state === "registered_dirty" || Boolean(status && !status.clean);
                const prunable = worktree.state === "prunable_metadata";
                const locked = worktree.state === "locked";
                const unknown = worktree.state === "registered_unknown" || worktree.state === "unknown";
                const orphaned = worktree.state.startsWith("orphaned_");
                const forceRequired = worktree.requiresForce;
                const statusReady = forceRequired || orphaned || (status !== undefined && status !== null);
                const pending = pendingPath === worktree.path;
                return (
                  <div key={worktree.path} className="rounded-md border border-line bg-raised p-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[13px] font-medium text-paper">
                          <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-ok" : dirty ? "bg-warn" : "bg-mute"}`} />
                          <span className="truncate">{worktree.branch ?? "Detached checkout"}</span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-mute" title={worktree.path}>
                          {worktree.path}
                        </div>
                        <div className="mt-1 text-[11px] text-mute">
                          {active ? "In use by a running agent" : prunable ? "Git metadata points to a missing checkout" : locked ? "Locked by Git" : unknown ? "Status unavailable; review before cleanup" : orphaned ? (worktree.state === "orphaned_empty" ? "Empty unregistered agent slot" : "Unregistered files found") : status === undefined ? "Checking files…" : status === null ? "Status unavailable" : dirty ? `${status.changedFiles.length} changed file${status.changedFiles.length === 1 ? "" : "s"}` : "Clean checkout"}
                        </div>
                      </div>
                      {active ? (
                        <span className="shrink-0 text-[11px] text-ok">In use</span>
                      ) : prunable ? (
                        <span className="shrink-0 text-[11px] text-mute">Prunable</span>
                      ) : locked || unknown ? (
                        <span className="shrink-0 text-[11px] text-warn">Review</span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant={forceRequired ? "destructive" : "ghost"}
                          disabled={busyPath !== null || !statusReady}
                          onClick={() => forceRequired ? requestForce(worktree) : void removeWorktree(worktree, false)}
                        >
                          {busyPath === worktree.path ? "Removing…" : forceRequired ? "Discard…" : "Remove"}
                        </Button>
                      )}
                    </div>
                    {pending && !active ? (
                      <div className="mt-3 border-t border-line pt-3">
                        <p className="text-[12px] leading-5 text-danger">
                          This checkout contains uncommitted or untracked files. Type <span className="font-mono">DELETE</span> to permanently remove them.
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="DELETE" autoFocus />
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={busyPath !== null || typed.trim().toUpperCase() !== "DELETE"}
                            onClick={() => void removeWorktree(worktree, true)}
                          >
                            Delete checkout
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
            <p className="max-w-[27rem] text-[11px] leading-4 text-mute">
              The worktree audit is read-only. It never deletes a registered checkout or assumes a clean folder is unused. Runtime reconciliation does not force-delete files.
            </p>
            {missingCount ? (
              <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void pruneMissingRecords()}>
                Prune missing records
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
