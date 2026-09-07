import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentProviderId } from "../types";
import { PROVIDER_CATALOG } from "../types";

export function AddAgentDialog() {
  const open = useUiStore((s) => s.addAgentOpen);
  const setOpen = useUiStore((s) => s.setAddAgentOpen);
  const providers = useAgentStore((s) => s.providers);
  const providersError = useAgentStore((s) => s.providersError);
  const loadProviders = useAgentStore((s) => s.loadProviders);
  const launch = useAgentStore((s) => s.launch);
  const launching = useAgentStore((s) => s.launching);
  const launchError = useAgentStore((s) => s.launchError);
  const project = useProjectStore((s) => s.project);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AgentProviderId>("claude-code");
  const [createWorktree, setCreateWorktree] = useState(true);

  useEffect(() => {
    if (open) void loadProviders();
  }, [open, loadProviders]);

  const selected = providers.find((item) => item.id === provider);
  const available = provider === "shell" || Boolean(selected?.installed);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const agent = await launch({
      name: name.trim() || (selected?.displayName ?? provider),
      provider,
      createWorktree,
    });
    if (agent) {
      setOpen(false);
      setName("");
    }
  }

  return (
    <Modal title="Add Agent" open={open} onClose={() => setOpen(false)}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
        {providersError ? (
          <div className="border border-[#5a1d1d] bg-[#3a1515] px-2 py-1.5 text-[11px] text-[#f14c4c]">
            {providersError.message}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => void loadProviders()}
            >
              Retry
            </button>
          </div>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[#8b8b8b]">Name</span>
          <input
            className="h-7 border border-[#3e3e42] bg-[#3c3c3c] px-2 text-[12px] outline-none focus:border-[#0e639c]"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Backend"
            autoFocus
          />
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] text-[#8b8b8b]">Provider</legend>
          {PROVIDER_CATALOG.map((item) => {
            const detected = providers.find((p) => p.id === item.id);
            const installed = Boolean(detected?.installed);
            const launchable = item.id === "shell" || installed;
            const statusLabel = installed ? "installed" : item.id === "shell" ? "local" : "unavailable";
            return (
              <label
                key={item.id}
                className={`flex items-center gap-2 px-1 py-0.5 ${launchable ? "" : "opacity-60"}`}
              >
                <input
                  type="radio"
                  name="provider"
                  checked={provider === item.id}
                  onChange={() => setProvider(item.id)}
                />
                <span>{item.displayName}</span>
                <span className={`ml-auto text-[11px] ${installed ? "text-[#89d185]" : launchable ? "text-[#8b8b8b]" : "text-[#f14c4c]"}`}>
                  {statusLabel}
                </span>
              </label>
            );
          })}
        </fieldset>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={createWorktree}
            onChange={(event) => setCreateWorktree(event.target.checked)}
          />
          <span>Create isolated Git worktree</span>
        </label>
        {project ? (
          <div className="text-[11px] text-[#8b8b8b]">
            Base branch: {project.baseBranch}. Isolation uses git_create_worktree.
          </div>
        ) : null}

        {!available ? (
          <div className="text-[11px] text-[#f14c4c]">
            This provider is not installed. Detection comes from the backend — it is not assumed.
          </div>
        ) : null}

        {launchError ? (
          <div className="border border-[#5a1d1d] bg-[#3a1515] px-2 py-1.5 text-[11px] text-[#f14c4c]">
            {launchError.message}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button type="button" className="h-7 px-3 hover:bg-[#3e3e42]" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type="submit"
            className="h-7 bg-[#0e639c] px-3 text-white hover:bg-[#1177bb] disabled:opacity-40"
            disabled={launching || !available}
          >
            {launching ? "Launching…" : "Launch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
