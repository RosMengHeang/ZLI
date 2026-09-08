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
    <Modal title="Commit changes" description="Save the selected working tree changes in a Git commit." open={open} busy={busy} onClose={() => setOpen(false)}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
        <div className="text-[12px] text-mute">
          {agent ? `${agent.name} · ${agent.branch}` : project?.name} — {worktreePath}
        </div>
        <textarea
          className="field field-area"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message"
          required
          autoFocus
        />
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={stageAll}
            onChange={(event) => setStageAll(event.target.checked)}
          />
          <span>Stage all changes before commit</span>
        </label>
        {error ? <div className="banner banner-error">{error.message}</div> : null}
        {lastCommit ? (
          <div className="font-mono text-[11px] text-mute">
            Last commit: {lastCommit.shortHash} {lastCommit.message}
          </div>
        ) : null}
        <div data-dialog-actions className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !message.trim()}>
            {busy ? "Committing…" : "Commit changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
