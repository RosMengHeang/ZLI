import { useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { toAppError } from "../lib/errors";
import { managedWorktrees } from "../lib/worktreePresentation";
import { gitListWorktrees, gitPruneWorktrees, gitRemoveWorktree, gitStatus } from "../tauri/git";
import type { GitStatus, WorktreeInfo } from "../types";
import { workspaceRootKey } from "../lib/workspaceRegistry";

function pathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
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
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, GitStatus | null>>({});
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const activePaths = new Set(
    Object.values(agents)
      .map((agent) => agent.worktreePath)
      .filter((path): path is string => Boolean(path))
      .map(pathKey),
  );

  const loadWorktrees = useCallback(async () => {
    if (!repositoryRoot) return;
    setLoading(true);
    setError(null);
    setPendingPath(null);
    setTyped("");
    try {
      const listed = managedWorktrees(await gitListWorktrees(repositoryRoot));
      setWorktrees(listed);
      const entries = await Promise.all(
        listed.map(async (worktree) => {
          if (worktree.prunable) return [worktree.path, null] as const;
          try {
            return [worktree.path, await gitStatus(worktree.path)] as const;
          } catch {
            return [worktree.path, null] as const;
          }
        }),
      );
      setStatuses(Object.fromEntries(entries));
    } catch (caught) {
      setError(toAppError(caught).message);
    } finally {
      setLoading(false);
    }
  }, [repositoryRoot]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void loadWorktrees(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorktrees, open]);

  async function removeWorktree(worktree: WorktreeInfo, force: boolean) {
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

  const missingCount = worktrees.filter((worktree) => worktree.prunable).length;

  return (
    <Modal
      title="Worktree storage"
      open={open}
      busy={loading || Boolean(busyPath)}
      onClose={() => setOpen(false)}
      width={620}
      description="Remove old agent checkouts to reclaim disk space. Git history and branches stay safe."
    >
      {!targetProject ? (
        <p className="text-[13px] text-mute">Open a project to manage its worktrees.</p>
      ) : (
        <div className="flex flex-col gap-3">
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
                const dirty = Boolean(status && !status.clean);
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
                          {active ? "In use by a running agent" : worktree.prunable ? "Missing from disk" : status === undefined ? "Checking files…" : status === null ? "Status unavailable" : dirty ? `${status.changedFiles.length} changed file${status.changedFiles.length === 1 ? "" : "s"}` : "Clean checkout"}
                        </div>
                      </div>
                      {active ? (
                        <span className="shrink-0 text-[11px] text-ok">In use</span>
                      ) : worktree.prunable ? (
                        <span className="shrink-0 text-[11px] text-mute">Prunable</span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant={dirty ? "destructive" : "ghost"}
                          disabled={busyPath !== null || status === undefined}
                          onClick={() => void removeWorktree(worktree, false)}
                        >
                          {busyPath === worktree.path ? "Removing…" : dirty ? "Discard…" : "Remove"}
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
              Removing a checkout frees its files. Its branch remains so committed work is not lost and can be merged later.
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
