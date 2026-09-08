import { useEffect, useState, type KeyboardEvent } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { DiffViewer } from "./DiffViewer";
import { fileStatusLabel, formatPlusMinus } from "../lib/format";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { providerDisplayName } from "../types";
import { changedFileLabel } from "../lib/gitPresentation";

export function GitReviewPanel() {
  const project = useProjectStore((s) => s.project);
  const agents = useAgentStore((s) => s.agents);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const agent = selectedAgentId ? agents[selectedAgentId] : undefined;
  const worktreePath = agent?.worktreePath || agent?.cwd || project?.path || "";
  const status = useGitStore((s) => (worktreePath ? s.statusByPath[worktreePath] : undefined));
  const refresh = useGitStore((s) => s.refresh);
  const loadDiff = useGitStore((s) => s.loadDiff);
  const selectedPath = useGitStore((s) => s.selectedPath);
  const diffs = useGitStore((s) => s.diffs);
  const loading = useGitStore((s) => s.loading);
  const diffLoading = useGitStore((s) => s.diffLoading);
  const error = useGitStore((s) => s.error);
  const mergeOutcome = useGitStore((s) => s.mergeOutcome);
  const abortMerge = useGitStore((s) => s.abortMerge);
  const setCommitOpen = useUiStore((s) => s.setCommitOpen);
  const setDiscardOpen = useUiStore((s) => s.setDiscardOpen);
  const setMergeOpen = useUiStore((s) => s.setMergeOpen);
  const [aborting, setAborting] = useState(false);

  useEffect(() => {
    if (!worktreePath) return;
    void refresh(worktreePath, { minIntervalMs: 1500 });
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void refresh(worktreePath, { quiet: true, minIntervalMs: 4000 });
    }, 8000);
    return () => window.clearInterval(id);
  }, [worktreePath, refresh]);

  if (!project) return null;

  const files = status?.changedFiles ?? [];
  const selectedDiff = selectedPath ? diffs[`${worktreePath}::${selectedPath}`] : undefined;
  const title = agent ? agent.name : project.name;
  const branch = agent?.branch || project.currentBranch;
  const subtitle = `${agent ? providerDisplayName(agent.provider) : "Working tree"} · ${branch}`;

  function onFileListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (files.length === 0) return;
    event.preventDefault();
    const current = selectedPath ? files.findIndex((file) => file.path === selectedPath) : -1;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(files.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
    void loadDiff(worktreePath, files[next].path);
  }

  async function onAbortMerge() {
    if (!project) return;
    setAborting(true);
    try {
      await abortMerge(project.repositoryRoot);
    } catch {
      /* store error */
    } finally {
      setAborting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-chrome px-3">
        {agent ? <ProviderIcon provider={agent.provider} size="sm" /> : null}
        <span className="truncate text-[13px] font-medium text-paper">{title}</span>
        <span className="truncate text-[11px] text-mute">{subtitle}</span>
        <span className="text-[11px] text-mute">{status ? `${files.length} files` : "No files"}</span>
        {status && !status.clean ? (
          <span className="font-mono text-[11px] text-ok">{formatPlusMinus(status.additions, status.deletions)}</span>
        ) : (
          <span className="text-[11px] text-mute">{status?.clean ? "Clean" : ""}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost h-7"
            onClick={() => void refresh(worktreePath)}
            disabled={loading || !worktreePath}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-primary h-7"
            onClick={() => setCommitOpen(true)}
            disabled={!status || status.clean}
          >
            Commit changes
          </button>
          <button type="button" className="btn btn-quiet h-7" onClick={() => setMergeOpen(true)} disabled={!agent}>
            Merge branch
          </button>
          <button
            type="button"
            className="btn btn-ghost h-7 text-danger hover:text-danger"
            onClick={() => setDiscardOpen(true)}
            disabled={!agent}
          >
            Discard
          </button>
        </span>
      </div>

      {error ? (
        <div className="banner banner-error m-2" role="alert">
          {error.message}
          {error.details ? <div className="mt-0.5 whitespace-pre-wrap opacity-80">{error.details}</div> : null}
          <button
            type="button"
            className="btn btn-ghost mt-2 h-7"
            onClick={() => void refresh(worktreePath)}
            disabled={loading || !worktreePath}
          >
            Retry
          </button>
        </div>
      ) : null}

      {mergeOutcome?.outcome === "conflict" ? (
        <div className="banner banner-error m-2">
          <div className="font-medium">
            Merge conflict: {mergeOutcome.sourceBranch} → {mergeOutcome.targetBranch}
          </div>
          <ul className="mt-1 list-disc pl-4">
            {mergeOutcome.conflictedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-danger mt-2 h-7"
            onClick={() => void onAbortMerge()}
            disabled={aborting}
          >
            {aborting ? "Aborting…" : "Abort merge"}
          </button>
        </div>
      ) : null}

      {mergeOutcome?.outcome === "success" ? (
        <div className="banner banner-ok m-2">
          Merged {mergeOutcome.sourceBranch} into {mergeOutcome.targetBranch}
          {mergeOutcome.fastForward ? " (fast-forward)" : ""} · {mergeOutcome.commitHash.slice(0, 8)}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div
          className="w-[210px] min-[980px]:w-[260px] shrink-0 overflow-auto border-r border-line"
          role="listbox"
          aria-label="Changed files"
          tabIndex={0}
          onKeyDown={onFileListKeyDown}
        >
          {files.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-mute">
              {status ? "Working tree is clean." : "Git status is not loaded yet."}
            </div>
          ) : (
            files.map((file) => {
              const active = selectedPath === file.path;
              const conflict = file.status === "unmerged";
              return (
                <button
                  key={file.path}
                  aria-label={changedFileLabel(file)}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12px] hover:bg-hover ${
                    active ? "bg-raised" : ""
                  }`}
                  role="option"
                  aria-selected={active}
                  onClick={() => void loadDiff(worktreePath, file.path)}
                >
                  <span
                    className={`w-4 text-center text-[10px] font-semibold ${
                      conflict ? "text-danger" : file.status === "added" ? "text-ok" : "text-warn"
                    }`}
                  >
                    {fileStatusLabel(file.status)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-paper" title={file.path}>
                    {file.path}
                  </span>
                  <span className="text-mute">{formatPlusMinus(file.additions, file.deletions)}</span>
                </button>
              );
            })
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          {diffLoading ? (
            <div className="p-4 text-[13px] text-mute">Loading diff…</div>
          ) : selectedDiff ? (
            <DiffViewer diff={selectedDiff.diff} binary={selectedDiff.binary} path={selectedDiff.path} />
          ) : (
            <div className="p-4 text-[13px] text-mute">Select a changed file to view its diff.</div>
          )}
        </div>
      </div>
    </div>
  );
}
