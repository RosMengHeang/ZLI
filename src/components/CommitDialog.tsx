import { useState } from "react";
import { Modal } from "./Modal";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";

export function CommitDialog() {
  const open = useUiStore((s) => s.commitOpen);
  const setOpen = useUiStore((s) => s.setCommitOpen);
  const project = useProjectStore((s) => s.project);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const agent = useAgentStore((s) => (selectedAgentId ? s.agents[selectedAgentId] : undefined));
  const commit = useGitStore((s) => s.commit);
  const error = useGitStore((s) => s.error);
  const lastCommit = useGitStore((s) => s.lastCommit);
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(true);
  const [busy, setBusy] = useState(false);

  const worktreePath = agent?.worktreePath || agent?.cwd || project?.path || "";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    setBusy(true);
    try {
      await commit({ worktreePath, message: message.trim(), stageAll });
      setMessage("");
      setOpen(false);
    } catch {
      /* error surfaced in store */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Commit" open={open} onClose={() => setOpen(false)}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
        <div className="text-[11px] text-[#8b8b8b]">
          {agent ? `${agent.name} · ${agent.branch}` : project?.name} — {worktreePath}
        </div>
        <textarea
          className="h-24 resize-none border border-[#3e3e42] bg-[#3c3c3c] p-2 font-mono text-[12px] outline-none focus:border-[#0e639c]"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message"
          required
          autoFocus
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={stageAll}
            onChange={(event) => setStageAll(event.target.checked)}
          />
          <span>Stage all changes (`git add -A`) before commit</span>
        </label>
        {error?.code === "nothingToCommit" || error ? (
          <div className="text-[11px] text-[#f14c4c]">{error.message}</div>
        ) : null}
        {lastCommit ? (
          <div className="text-[11px] text-[#8b8b8b]">
            Last commit: {lastCommit.shortHash} {lastCommit.message}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="h-7 px-3 hover:bg-[#3e3e42]" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type="submit"
            className="h-7 bg-[#0e639c] px-3 text-white hover:bg-[#1177bb] disabled:opacity-40"
            disabled={busy || !message.trim()}
          >
            {busy ? "Committing…" : "Commit"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
