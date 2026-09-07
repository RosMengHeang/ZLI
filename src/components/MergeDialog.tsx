import { useState } from "react";
import { Modal } from "./Modal";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";

export function MergeDialog() {
  const open = useUiStore((s) => s.mergeOpen);
  const setOpen = useUiStore((s) => s.setMergeOpen);
  const project = useProjectStore((s) => s.project);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const agent = useAgentStore((s) => (selectedAgentId ? s.agents[selectedAgentId] : undefined));
  const merge = useGitStore((s) => s.merge);
  const error = useGitStore((s) => s.error);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const targetBranch = target.trim() || project?.baseBranch || "main";

  async function onMerge(event: React.FormEvent) {
    event.preventDefault();
    if (!project || !agent) return;
    setBusy(true);
    try {
      const outcome = await merge({
        repositoryRoot: project.repositoryRoot,
        sourceBranch: agent.branch,
        targetBranch,
      });
      if (outcome.outcome === "success") setOpen(false);
    } catch {
      /* store error */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Merge agent branch" open={open} onClose={() => setOpen(false)}>
      {!agent || !project ? (
        <p className="text-[12px]">Select an agent with a branch first.</p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(event) => void onMerge(event)}>
          <p className="text-[12px] leading-5">
            Merge <span className="font-mono text-[#9cdcfe]">{agent.branch}</span> into the
            repository root. Conflicts are left in place for you to resolve or abort — nothing is
            force-reset.
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[#8b8b8b]">Target branch</span>
            <input
              className="h-7 border border-[#3e3e42] bg-[#3c3c3c] px-2 font-mono outline-none focus:border-[#0e639c]"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={project.baseBranch}
            />
          </label>
          {error ? <div className="text-[11px] text-[#f14c4c]">{error.message}</div> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="h-7 px-3 hover:bg-[#3e3e42]" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="h-7 bg-[#0e639c] px-3 text-white hover:bg-[#1177bb] disabled:opacity-40"
              disabled={busy}
            >
              {busy ? "Merging…" : "Merge"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
