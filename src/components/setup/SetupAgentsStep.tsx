import type { AgentProvider, AgentProviderId } from "../../types";
import { providerDisplayName } from "../../types";
import { ProviderIcon } from "../ProviderIcon";
import {
  MAX_AGENT_COUNT,
  MAX_TOTAL_AGENT_COUNT,
  clampProviderQuantity,
  plannedAgentCount,
  providerSelectionState,
  type AgentDraft,
} from "./setupModel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface Props {
  rows: AgentDraft[];
  providers: AgentProvider[];
  scanning: boolean;
  error?: string;
  onRescan: () => void;
  onSetQuantity: (provider: AgentProviderId, quantity: number) => void;
  onUpdate: (id: string, patch: Partial<AgentDraft>) => void;
  onBack: () => void;
  projectLocked?: boolean;
  onContinue: () => void;
}

function providerStatus(
  ready: boolean,
  installed: boolean,
  scanning: boolean,
): string {
  if (scanning) return "Checking this computer…";
  if (!ready) return "Not found · install CLI and rescan";
  return installed ? "Ready to launch" : "Built-in terminal";
}

export function SetupAgentsStep(props: Props) {
  const cards = providerSelectionState(props.providers, props.rows).sort(
    (a, b) => Number(b.ready) - Number(a.ready),
  );
  const total = plannedAgentCount(props.rows);

  function setQuantity(provider: AgentProviderId, quantity: number) {
    props.onSetQuantity(provider, clampProviderQuantity(quantity));
  }

  return (
    <section aria-labelledby="agents-title" className="setup-agents-step">
      <div className="setup-section-heading">
        <div>
          <h2 id="agents-title" className="setup-section-title">
            Choose your agent mix
          </h2>
          <p className="setup-section-copy">
            Turn on the providers you want, then choose how many agents each
            provider should run.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={props.scanning}
          onClick={props.onRescan}
        >
          {props.scanning ? "Scanning…" : "Rescan"}
        </Button>
      </div>

      {props.error && (
        <p role="alert" className="banner banner-error mt-5">
          {props.error}
        </p>
      )}

      <div className="setup-provider-grid" aria-label="Detected agent providers">
        {cards.map((provider) => {
          const canIncrease =
            provider.ready &&
            provider.count < MAX_AGENT_COUNT &&
            total < MAX_TOTAL_AGENT_COUNT;
          return (
            <article
              key={provider.id}
              className="setup-provider-card"
              data-selected={provider.selected}
              data-disabled={!provider.ready}
            >
              <div className="flex min-w-0 items-start gap-3">
                <ProviderIcon provider={provider.id} size="lg" />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[13px] font-semibold">
                    {provider.displayName}
                  </h3>
                  <p className="mt-1 text-[11px] text-mute">
                    {providerStatus(provider.ready, provider.installed, props.scanning)}
                  </p>
                </div>
                <span
                  className="setup-provider-check"
                  data-visible={provider.selected}
                  aria-hidden="true"
                >
                  ✓
                </span>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium text-mute">
                  Agents
                </span>
                <div
                  className="setup-quantity-control"
                  role="group"
                  aria-label={`${provider.displayName} agent quantity`}
                >
                  <button
                    type="button"
                    className="setup-quantity-button"
                    disabled={props.scanning || provider.count === 0}
                    onClick={() => setQuantity(provider.id, provider.count - 1)}
                    aria-label={`Decrease ${provider.displayName} agents`}
                  >
                    −
                  </button>
                  <output
                    className="setup-quantity-value"
                    aria-live="polite"
                    aria-label={`${provider.count} agents`}
                  >
                    {provider.count}
                  </output>
                  <button
                    type="button"
                    className="setup-quantity-button"
                    disabled={props.scanning || !canIncrease}
                    onClick={() => setQuantity(provider.id, provider.count + 1)}
                    aria-label={`Increase ${provider.displayName} agents`}
                  >
                    +
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <details className="setup-advanced">
        <summary>Customize names and Git worktrees</summary>
        <div className="mt-4 space-y-3">
          {props.rows.length ? (
            props.rows.map((row) => (
              <div key={row.id} className="setup-advanced-row">
                <label className="min-w-0 flex-1 text-xs text-mute">
                  {providerDisplayName(row.provider)} name
                  <Input
                    className="mt-1"
                    value={row.role}
                    placeholder={providerDisplayName(row.provider)}
                    onChange={(event) =>
                      props.onUpdate(row.id, { role: event.target.value })
                    }
                  />
                </label>
                <label className="setup-worktree-toggle">
                  <input
                    type="checkbox"
                    checked={row.useWorktree}
                    onChange={(event) =>
                      props.onUpdate(row.id, {
                        useWorktree: event.target.checked,
                      })
                    }
                  />
                  Isolated worktree
                </label>
              </div>
            ))
          ) : (
            <p className="text-xs text-mute">
              Select a provider above to customize its agent names or use
              isolated Git worktrees.
            </p>
          )}
        </div>
      </details>

      <div className="setup-step-footer">
        <div>
          <p className="text-[12px] font-medium text-paper">
            {total
              ? `${total} agent${total === 1 ? "" : "s"} selected`
              : "No agents selected"}
          </p>
          <p className="mt-1 text-[11px] text-mute">
            You can add more agents from the workspace later.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={props.projectLocked}
            title={
              props.projectLocked
                ? "Running agents belong to this project"
                : undefined
            }
            onClick={props.onBack}
          >
            Back
          </Button>
          <Button
            type="button"
            className="min-h-10"
            onClick={props.onContinue}
          >
            Review launch
          </Button>
        </div>
      </div>
    </section>
  );
}
