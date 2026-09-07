import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { ProviderIcon } from "./ProviderIcon";
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
    <Modal title="Add agent" open={open} onClose={() => setOpen(false)} width={520}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
        {providersError ? (
          <div className="banner banner-error">
            {providersError.message}
            <button type="button" className="ml-2 underline" onClick={() => void loadProviders(true)}>
              Retry
            </button>
          </div>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-mute">Name</span>
          <input
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Backend"
            autoFocus
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[12px] text-mute">Provider</legend>
          <div className="grid max-h-[min(52vh,28rem)] gap-1.5 overflow-auto pr-0.5" role="radiogroup" aria-label="Provider">
            {PROVIDER_CATALOG.map((item) => {
              const detected = providers.find((p) => p.id === item.id);
              const installed = Boolean(detected?.installed);
              const launchable = item.id === "shell" || installed;
              const statusLabel = installed ? "Installed" : item.id === "shell" ? "Always ready" : "Not found";
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={provider === item.id}
                  data-selected={provider === item.id}
                  data-disabled={!launchable}
                  className="provider-card"
                  onClick={() => setProvider(item.id)}
                >
                  <ProviderIcon provider={item.id} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-paper">{item.displayName}</span>
                    <span className="block truncate font-mono text-[11px] text-mute">
                      {detected?.executable || (item.id === "shell" ? "System shell" : item.id)}
                    </span>
                  </span>
                  <span className={`text-[11px] ${installed ? "text-ok" : launchable ? "text-mute" : "text-danger"}`}>
                    {statusLabel}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={createWorktree}
            onChange={(event) => setCreateWorktree(event.target.checked)}
          />
          Isolated worktree
        </label>
        {project ? (
          <div className="text-[12px] text-mute">
            Base branch {project.baseBranch}. Isolation uses a dedicated worktree.
          </div>
        ) : null}

        {!available ? (
          <div className="banner banner-error">
            This provider is not installed on this machine. Install the CLI, then scan tools again.
          </div>
        ) : null}

        {launchError ? <div className="banner banner-error">{launchError.message}</div> : null}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={launching || !available}>
            {launching ? "Launching…" : "Launch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
