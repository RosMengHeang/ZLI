import { useState } from "react";
import { Modal } from "./Modal";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";

export function DiscardDialog() {
  const open = useUiStore((s) => s.discardOpen);
  const setOpen = useUiStore((s) => s.setDiscardOpen);
  const project = useProjectStore((s) => s.project);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const agent = useAgentStore((s) => (selectedAgentId ? s.agents[selectedAgentId] : undefined));
  const removeAgent = useAgentStore((s) => s.remove);
  const statusByPath = useGitStore((s) => s.statusByPath);
  const discardWorktree = useGitStore((s) => s.discardWorktree);
  const error = useGitStore((s) => s.error);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const paneTreeLeaves = useLayoutStore((s) => s.leaves);
  const closePane = useLayoutStore((s) => s.closePane);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  const isolated =
    Boolean(agent?.worktreePath) &&
    Boolean(project) &&
    agent!.worktreePath !== project!.repositoryRoot &&
    agent!.worktreePath !== project!.path;

  const gitPath = agent?.worktreePath || agent?.cwd || "";
  const changed = statusByPath[gitPath]?.changedFiles.length ?? 0;
  const confirmWord = "discard";

  async function onDiscard() {
    if (!agent || !project || !isolated || typed.trim().toLowerCase() !== confirmWord) return;
    setBusy(true);
    try {
      await discardWorktree({
        repositoryRoot: project.repositoryRoot,
        worktreePath: agent.worktreePath as string,
        branch: agent.branch,
      });
      for (const leaf of paneTreeLeaves()) {
        if (leaf.terminalId === agent.terminalId) closePane(leaf.id);
      }
      await closeSession(agent.terminalId);
      removeAgent(agent.id);
      setTyped("");
      setOpen(false);
    } catch {
      /* store error */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={agent ? `Discard ${agent.name} agent work?` : "Discard agent work?"}
      open={open}
      busy={busy}
      description="Review the affected worktree before discarding its changes."
      onClose={() => setOpen(false)}
      danger
    >
      {!agent ? (
        <p className="text-[13px]">Select an agent first.</p>
      ) : !isolated ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-5">
            This agent is using the project working tree, not an isolated worktree. Discarding it
            here would risk destroying your own uncommitted work, so it is blocked.
          </p>
          <p className="font-mono text-[12px] text-mute">{agent.cwd}</p>
          <div className="flex justify-end">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-5">
            This removes the isolated worktree and may delete uncommitted files. It is not
            reversible from this app.
          </p>
          <div className="banner banner-error font-mono text-[12px] leading-5">
            <div>Branch: {agent.branch}</div>
            <div>Worktree: {agent.worktreePath}</div>
            <div>{changed} changed files may be lost.</div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-mute">
              Type <span className="font-mono text-paper">{confirmWord}</span> to confirm
            </span>
            <input
              className="field border-[#5a2430] font-mono"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoFocus
            />
          </label>
          {error ? <div className="banner banner-error">{error.message}</div> : null}
          <div data-dialog-actions className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || typed.trim().toLowerCase() !== confirmWord}
              onClick={() => void onDiscard()}
            >
              {busy ? "Discarding…" : "Discard worktree"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
