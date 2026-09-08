import { useState } from "react";
import { Modal } from "./Modal";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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
    <Modal title="Merge branch" description="Review the source and target before combining changes." open={open} busy={busy} onClose={() => setOpen(false)}>
      {!agent || !project ? (
        <p className="text-[13px]">Select an agent with a branch first.</p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(event) => void onMerge(event)}>
          <p className="text-[13px] leading-5 text-mute">
            Merge <span className="font-mono text-branch">{agent.branch}</span> into the
            repository root. Conflicts are left in place for you to resolve or abort. Nothing is
            force-reset.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-mute">Target branch</span>
            <Input
              className="field font-mono"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={project.baseBranch}
            />
          </label>
          {error ? <div className="banner banner-error">{error.message}</div> : null}
        <div data-dialog-actions className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Merging…" : "Merge branch"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
