import { useEffect } from "react";
import { DiffViewer } from "./DiffViewer";
import { fileStatusLabel, formatPlusMinus } from "../lib/format";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { providerDisplayName } from "../types";

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

  useEffect(() => {
    if (worktreePath) void refresh(worktreePath);
  }, [worktreePath, refresh]);

  if (!project) return null;

  const files = status?.changedFiles ?? [];
  const selectedDiff = selectedPath ? diffs[`${worktreePath}::${selectedPath}`] : undefined;
  const title = agent
    ? `${agent.name} — ${providerDisplayName(agent.provider)}`
    : `${project.name} — working tree`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[#3e3e42] bg-[#2d2d2d] px-2">
        <span className="truncate text-[11px] font-medium text-white">{title}</span>
        <span className="text-[11px] text-[#8b8b8b]">
          {status ? `${files.length} files` : "—"}
        </span>
        {status && !status.clean ? (
          <span className="text-[11px] text-[#89d185]">
            {formatPlusMinus(status.additions, status.deletions)}
          </span>
        ) : (
          <span className="text-[11px] text-[#8b8b8b]">{status?.clean ? "clean" : ""}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="h-5 px-1.5 text-[11px] text-[#cccccc] hover:bg-[#3e3e42]"
            onClick={() => void refresh(worktreePath)}
            disabled={loading || !worktreePath}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="h-5 px-1.5 text-[11px] text-[#cccccc] hover:bg-[#3e3e42] disabled:opacity-40"
            onClick={() => setCommitOpen(true)}
            disabled={!status || status.clean}
          >
            Commit
          </button>
          <button
            type="button"
            className="h-5 px-1.5 text-[11px] text-[#cccccc] hover:bg-[#3e3e42] disabled:opacity-40"
            onClick={() => setMergeOpen(true)}
            disabled={!agent}
          >
            Merge
          </button>
          <button
            type="button"
            className="h-5 px-1.5 text-[11px] text-[#f14c4c] hover:bg-[#3e3e42] disabled:opacity-40"
            onClick={() => setDiscardOpen(true)}
            disabled={!agent}
          >
            Discard
          </button>
        </span>
      </div>

      {error ? (
        <div className="border-b border-[#5a1d1d] bg-[#3a1515] px-2 py-1 text-[11px] text-[#f14c4c]">
          {error.message}
          {error.details ? <div className="mt-0.5 whitespace-pre-wrap text-[#d7a1a1]">{error.details}</div> : null}
        </div>
      ) : null}

      {mergeOutcome?.outcome === "conflict" ? (
        <div className="border-b border-[#5a1d1d] bg-[#3a1515] px-2 py-1.5 text-[11px]">
          <div className="font-medium text-[#f14c4c]">
            Merge conflict: {mergeOutcome.sourceBranch} → {mergeOutcome.targetBranch}
          </div>
          <ul className="mt-1 list-disc pl-4 text-[#d7a1a1]">
            {mergeOutcome.conflictedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-1 h-5 px-1.5 text-[11px] text-white hover:bg-[#5a1d1d]"
            onClick={() => void abortMerge(project.repositoryRoot)}
          >
            Abort merge
          </button>
        </div>
      ) : null}

      {mergeOutcome?.outcome === "success" ? (
        <div className="border-b border-[#2d4a2d] bg-[#1b2e1b] px-2 py-1 text-[11px] text-[#89d185]">
          Merged {mergeOutcome.sourceBranch} into {mergeOutcome.targetBranch}
          {mergeOutcome.fastForward ? " (fast-forward)" : ""} · {mergeOutcome.commitHash.slice(0, 8)}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="w-[240px] shrink-0 overflow-auto border-r border-[#3e3e42]">
          {files.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-[#8b8b8b]">
              {status ? "Working tree clean." : "Git status not loaded."}
            </div>
          ) : (
            files.map((file) => {
              const active = selectedPath === file.path;
              const conflict = file.status === "unmerged";
              return (
                <button
                  key={file.path}
                  type="button"
                  className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left font-mono text-[11px] hover:bg-[#2a2d2e] ${
                    active ? "bg-[#37373d]" : ""
                  }`}
                  onClick={() => void loadDiff(worktreePath, file.path)}
                >
                  <span className={conflict ? "text-[#f14c4c]" : "text-[#cca700]"}>
                    {fileStatusLabel(file.status)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[#cccccc]" title={file.path}>
                    {file.path}
                  </span>
                  <span className="text-[#8b8b8b]">
                    {formatPlusMinus(file.additions, file.deletions)}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          {diffLoading ? (
            <div className="p-3 text-[12px] text-[#8b8b8b]">Loading diff…</div>
          ) : selectedDiff ? (
            <DiffViewer diff={selectedDiff.diff} binary={selectedDiff.binary} path={selectedDiff.path} />
          ) : (
            <div className="p-3 text-[12px] text-[#8b8b8b]">Select a changed file to view its diff.</div>
          )}
        </div>
      </div>
    </div>
  );
}
