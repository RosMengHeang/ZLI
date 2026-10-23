import type { ProviderModelOption } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_RUNS, MAX_RUNS, MIN_RUNS, type RunAgent, resizeRuns } from "../sessions/bestOf.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { DEFAULT_MODEL, ModelMark, modelOptions } from "../ui/ModelMark.js";
import { Picker, type PickerOption } from "../ui/Picker.js";
import { ProviderMark } from "../ui/ProviderMark.js";

/** An installed agent a run can use, with the models it lists. */
export type BestOfAgentOption = {
  provider: string;
  name: string;
  models?: readonly ProviderModelOption[] | undefined;
};

const RUN_COUNTS = Array.from({ length: MAX_RUNS - MIN_RUNS + 1 }, (_, index) => MIN_RUNS + index);

/**
 * Picks how many runs to start and the agent and model for each. It sits above the composer and
 * closes on Escape or a click elsewhere; clicks inside a picker's list, which renders in the body,
 * count as inside.
 */
export function BestOfPopover({
  agents,
  current,
  retryText,
  starting,
  error,
  onStart,
  onClose,
}: {
  agents: readonly BestOfAgentOption[];
  /** The chat's own agent and model, used for every run until the person changes one. */
  current: RunAgent;
  /** Try N ways: the earlier message every run sends again. */
  retryText?: string | undefined;
  starting: boolean;
  error?: string | undefined;
  onStart(runs: RunAgent[]): void;
  onClose(): void;
}) {
  const [runs, setRuns] = useState<RunAgent[]>(() => resizeRuns([], DEFAULT_RUNS, current));
  const ref = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    startRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target) || target.closest(".picker-menu, .send-split")) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const agentOptions = useMemo((): PickerOption<string>[] => {
    const listed = agents.some((agent) => agent.provider === current.provider)
      ? agents
      : [{ provider: current.provider, name: current.provider }, ...agents];
    return listed.map((agent) => ({
      value: agent.provider,
      label: agent.name,
      icon: <ProviderMark provider={agent.provider} size={15} />,
    }));
  }, [agents, current.provider]);

  const update = (index: number, change: Partial<RunAgent>) =>
    setRuns((list) => list.map((run, position) => (position === index ? { ...run, ...change } : run)));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const count = runs.length;
  return (
    <div
      ref={ref}
      className="best-of"
      role="dialog"
      aria-label={retryText ? "Try N ways" : "Send as Best of N"}
      onKeyDown={onKeyDown}
    >
      <div className="best-of-head">
        <Icon name="split" size={14} />
        <span className="best-of-title">{retryText ? "Try N ways" : "Best of N"}</span>
        <fieldset className="best-of-counts" aria-label="Runs">
          {RUN_COUNTS.map((option) => (
            <button
              key={option}
              type="button"
              className="best-of-count"
              aria-pressed={option === count}
              aria-label={`${option} runs`}
              onClick={() => setRuns((list) => resizeRuns(list, option, current))}
            >
              {option}
            </button>
          ))}
        </fieldset>
        <IconButton label="Close" icon="x" size="xs" iconSize={12} onClick={onClose} />
      </div>
      {retryText ? (
        <p className="best-of-prompt" title={retryText}>
          {retryText.trim().split(/\r?\n/u)[0]}
        </p>
      ) : null}
      <ol className="best-of-runs">
        {runs.map((run, index) => {
          const agent = agents.find((entry) => entry.provider === run.provider);
          const models = modelOptions(agent?.models, run.model);
          const modelLabel = models.find((option) => option.value === (run.model ?? DEFAULT_MODEL))?.label ?? run.model;
          const agentName = agent?.name ?? run.provider;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row is the run at that position.
            <li className="best-of-run" key={index}>
              <span className="best-of-run-label">Run {index + 1}</span>
              <Picker
                label={`Agent for run ${index + 1}`}
                className="best-of-agent"
                value={run.provider}
                options={agentOptions}
                onChange={(provider) => update(index, { provider, model: undefined })}
              >
                <ProviderMark provider={run.provider} size={13} />
                <span className="picker-trigger-label">{agentName}</span>
              </Picker>
              <Picker
                label={`Model for run ${index + 1}`}
                className="best-of-model"
                value={run.model ?? DEFAULT_MODEL}
                options={models}
                onChange={(model) => update(index, { model: model || undefined })}
              >
                <ModelMark id={run.model} label={modelLabel} size={13} />
                <span className="picker-trigger-label">{modelLabel}</span>
              </Picker>
            </li>
          );
        })}
      </ol>
      {error ? (
        <p className="best-of-error" role="alert">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : null}
      <div className="best-of-footer">
        <span>
          Creates {count} worktrees from {retryText ? "the state before this message" : "the current state"}
        </span>
        <Button ref={startRef} variant="primary" size="sm" disabled={starting} onClick={() => onStart(runs)}>
          {starting ? "Starting" : "Start runs"}
        </Button>
      </div>
    </div>
  );
}
