import type { AgentProvider, AgentProviderId } from "../../types";
import { providerDisplayName } from "../../types";
import { IconTrash } from "../AppIcons";
import { ProviderIcon } from "../ProviderIcon";
import type { AgentDraft } from "./setupModel";

interface Props {
  rows: AgentDraft[];
  providers: AgentProvider[];
  scanning: boolean;
  error?: string;
  onRescan: () => void;
  onAdd: (provider: AgentProviderId) => void;
  onUpdate: (id: string, patch: Partial<AgentDraft>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, offset: number) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function SetupAgentsStep(props: Props) {
  return (
    <section aria-labelledby="agents-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="agents-title" className="text-[17px] font-semibold">
          Choose your agents
        </h2>
        <button
          className="btn btn-quiet"
          disabled={props.scanning}
          onClick={props.onRescan}
        >
          {props.scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <p className="mt-2 text-mute">
        Add a local tool, then choose one to six copies for each row.
      </p>
      {props.error && (
        <p role="alert" className="mt-3 text-danger">
          {props.error}
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {[...props.providers]
          .sort(
            (a, b) =>
              Number(b.installed || b.id === "shell") -
              Number(a.installed || a.id === "shell"),
          )
          .map((provider) => {
            const ready = provider.id === "shell" || provider.installed;
            return (
              <button
                key={provider.id}
                className="provider-card"
                disabled={!ready || props.scanning}
                onClick={() => props.onAdd(provider.id)}
              >
                <ProviderIcon provider={provider.id} size="sm" />
                <span className="min-w-0">
                  <span className="block">{provider.displayName}</span>
                  <span className="block text-xs text-mute">
                    {props.scanning
                      ? "Checking…"
                      : ready
                        ? "Add agent"
                        : "Not found · install CLI, then rescan"}
                  </span>
                </span>
              </button>
            );
          })}
      </div>
      <ol className="mt-5 space-y-3" aria-label="Planned agents">
        {props.rows.map((row, index) => (
          <li
            key={row.id}
            className="rounded-xl border border-line bg-raised p-3"
          >
            <div className="mb-3 flex items-center gap-2">
              <ProviderIcon provider={row.provider} size="sm" />
              <span className="flex-1 font-medium">
                {providerDisplayName(row.provider)}
              </span>
              <button
                className="btn btn-ghost"
                disabled={index === 0}
                onClick={() => props.onMove(row.id, -1)}
                aria-label={`Move ${providerDisplayName(row.provider)} row ${index + 1} up`}
              >
                Move up
              </button>
              <button
                className="btn btn-ghost"
                disabled={index === props.rows.length - 1}
                onClick={() => props.onMove(row.id, 1)}
                aria-label={`Move ${providerDisplayName(row.provider)} row ${index + 1} down`}
              >
                Move down
              </button>
              <button
                className="btn btn-icon"
                title="Remove agent"
                aria-label={`Remove ${providerDisplayName(row.provider)} row ${index + 1}`}
                onClick={() => props.onRemove(row.id)}
              >
                <IconTrash />
              </button>
            </div>
            <div className="flex gap-3">
              <label className="min-w-0 flex-1 text-xs text-mute">
                Role or name
                <input
                  className="field mt-1"
                  value={row.role}
                  placeholder={providerDisplayName(row.provider)}
                  onChange={(event) =>
                    props.onUpdate(row.id, { role: event.target.value })
                  }
                />
              </label>
              <label className="w-20 text-xs text-mute">
                Quantity
                <select
                  className="field mt-1"
                  value={row.count}
                  onChange={(event) =>
                    props.onUpdate(row.id, {
                      count: Number(event.target.value),
                    })
                  }
                >
                  {[1, 2, 3, 4, 5, 6].map((count) => (
                    <option key={count}>{count}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-mute">
              <input
                type="checkbox"
                checked={row.useWorktree}
                onChange={(event) =>
                  props.onUpdate(row.id, { useWorktree: event.target.checked })
                }
              />
              Use an isolated Git worktree
            </label>
          </li>
        ))}
      </ol>
      {!props.rows.length && (
        <p className="mt-4 text-mute">
          No agents selected. You can also add them after opening the workspace.
        </p>
      )}
      <div className="mt-6 flex justify-between">
        <button className="btn btn-ghost" onClick={props.onBack}>
          Back
        </button>
        <button className="btn btn-primary min-h-10" onClick={props.onContinue}>
          Review
        </button>
      </div>
    </section>
  );
}
