import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { ProviderIcon } from "./ProviderIcon";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentProviderId } from "../types";
import { PROVIDER_CATALOG } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<AgentProviderId>("claude-code");
  const [createWorktree, setCreateWorktree] = useState(true);

  useEffect(() => {
    if (open) void loadProviders();
  }, [open, loadProviders]);

  const selected = providers.find((item) => item.id === provider);
  const available = provider === "shell" || Boolean(selected?.installed);
  const visibleProviders = PROVIDER_CATALOG.filter((item) =>
    item.displayName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

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
    <Modal title="Add agent" description="Choose a local tool and where it should work." open={open} busy={launching} onClose={() => setOpen(false)} width={520}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
        {providersError ? (
          <div className="banner banner-error">
            {providersError.message}
            <Button type="button" variant="link" size="sm" className="ml-1 h-auto p-0" onClick={() => void loadProviders(true)}>
              Retry
            </Button>
          </div>
        ) : null}

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search agents…"
          aria-label="Search agents"
          autoFocus
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[12px] text-mute">Provider</legend>
          <div className="grid max-h-[min(42vh,22rem)] gap-1 overflow-auto pr-0.5" role="radiogroup" aria-label="Provider">
            {visibleProviders.map((item) => {
              const detected = providers.find((p) => p.id === item.id);
              const installed = Boolean(detected?.installed);
              const launchable = item.id === "shell" || installed;
              const statusLabel = installed ? "Installed" : item.id === "shell" ? "Built in" : "Not found";
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
                  <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-paper">{item.displayName}</span>
                  <span className={`text-[11px] ${installed ? "text-ok" : launchable ? "text-mute" : "text-danger"}`}>
                    {statusLabel}
                  </span>
                </button>
              );
            })}
            {!visibleProviders.length ? <p className="px-2 py-6 text-center text-[12px] text-mute">No matching agents</p> : null}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-mute">Agent name</span>
          <Input
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Backend"
          />
        </label>

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

        <div data-dialog-actions className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={launching} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={launching || !available}>
            {launching ? "Launching…" : "Add agent"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
