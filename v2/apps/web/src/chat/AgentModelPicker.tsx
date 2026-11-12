import type { ProviderModelOption } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { scrollMovesAnchor, useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Icon } from "../ui/Icon.js";
import { DEFAULT_MODEL, ModelMark, modelOptions } from "../ui/ModelMark.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import type { AgentChoice } from "./agentModels.js";

type Row = AgentChoice;

/** Row heights the split menu is sized from. chat.css pins the rows to these, so the sum is exact. */
const AGENT_ROW = 44;
const MODEL_ROW = 32;
const ROW_GAP = 1;
const HEADING = 30;
const LIST_PADDING = 8;
const MAX_HEIGHT = 400;

const listHeight = (rows: number, row: number) => rows * row + Math.max(0, rows - 1) * ROW_GAP;

/**
 * Picks the agent first and then one of its models, so a long model list never buries the agents. With no
 * other agent to offer, as once a conversation has started, it is a plain list of the agent's models.
 */
export function AgentModelPicker({
  provider,
  agentName,
  agentPlan,
  models,
  model,
  others,
  locked,
  tooltip,
  onModelChange,
  onAgentChange,
}: {
  provider: string | undefined;
  agentName: string;
  /** The chat's own agent's plan, shown beside its name. */
  agentPlan?: string | undefined;
  models: readonly ProviderModelOption[] | undefined;
  model: string | undefined;
  others: readonly AgentChoice[];
  /** The agent cannot change models inside this session. */
  locked: boolean;
  tooltip: string;
  onModelChange(model: string | undefined): void;
  onAgentChange(provider: string, model: string | undefined): void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(provider);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  const agentsId = useId();
  const modelsId = useId();
  const placement = useAnchoredPlacement(open, triggerRef, menuRef, {
    prefer: "above",
    align: "start",
    gap: 6,
    edge: 8,
  });
  const own: Row = {
    provider: (provider ?? "") as Row["provider"],
    name: agentName,
    models,
    plan: agentPlan,
  };
  const agents = [own, ...others];
  const twoColumns = others.length > 0;
  const active = agents.find((agent) => agent.provider === shown) ?? own;
  const isOwn = active.provider === own.provider;
  const choices = modelOptions(active.models, isOwn ? model : undefined, active.provider || undefined);
  const selectedValue = isOwn ? (model ?? DEFAULT_MODEL) : undefined;
  const ownChoices = modelOptions(models, model, provider);
  // Sized for the agent with the most models, so moving between agents never resizes the menu.
  const tallest = Math.max(
    listHeight(agents.length, AGENT_ROW),
    ...agents.map((agent) =>
      listHeight(
        modelOptions(agent.models, agent.provider === own.provider ? model : undefined, agent.provider || undefined)
          .length,
        MODEL_ROW,
      ),
    ),
  );
  const splitHeight = HEADING + LIST_PADDING + tallest + 2;
  const modelLabel = ownChoices.find((option) => option.value === (model ?? DEFAULT_MODEL))?.label ?? model ?? "";

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (!placed) return;
    const target =
      modelsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      menuRef.current?.querySelector<HTMLElement>('[role="option"]');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [placed]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (menuRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const onScroll = (event: Event) => {
      if (scrollMovesAnchor(event, triggerRef.current)) close(false);
    };
    const onLeave = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  });

  const pick = (agent: Row, value: string) => {
    close(true);
    const next = value || undefined;
    if (agent.provider === own.provider) {
      if (next !== model) onModelChange(next);
    } else onAgentChange(agent.provider, next);
  };

  const focusIn = (list: HTMLElement | null, which: "selected" | "first") => {
    const target =
      (which === "selected" ? list?.querySelector<HTMLElement>('[aria-selected="true"]') : null) ??
      list?.querySelector<HTMLElement>('[role="option"]');
    target?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = (event.target as HTMLElement).closest<HTMLElement>('[role="listbox"]');
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!list) return;
    const inAgents = list === agentsRef.current;
    if (event.key === "ArrowRight" && inAgents) {
      event.preventDefault();
      focusIn(modelsRef.current, "selected");
      return;
    }
    if (event.key === "ArrowLeft" && !inAgents && twoColumns) {
      event.preventDefault();
      focusIn(agentsRef.current, "selected");
      return;
    }
    const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key.length === 1 && /\S/u.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLowerCase();
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      next = ordered.find((item) => item.dataset.label?.toLowerCase().startsWith(key));
      if (!next) return;
    } else return;
    event.preventDefault();
    next?.focus();
    next?.scrollIntoView?.({ block: "nearest" });
    if (inAgents && next?.dataset.agent) setShown(next.dataset.agent);
  };

  const hoverFocus = (event: { currentTarget: HTMLElement }) => {
    if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-ghost picker-trigger composer-model${model ? "" : " is-default"}${locked ? " is-disabled" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${modelLabel}`}
        aria-disabled={locked || undefined}
        data-tooltip={open ? undefined : tooltip}
        onClick={() => {
          if (locked) return;
          if (open) close(false);
          else {
            setShown(provider);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (locked || open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          setShown(provider);
          setOpen(true);
        }}
      >
        <ModelMark id={model} label={modelLabel} agent={provider} size={14} />
        <span className="picker-trigger-label">{model ? modelLabel : agentName}</span>
        <Icon name="chevronDown" size={12} className="picker-chevron" />
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the two lists inside it.
            <div
              ref={menuRef}
              className={`picker-menu agent-model-menu${twoColumns ? " is-split" : ""}`}
              data-side={placement && "top" in placement ? "bottom" : "top"}
              style={
                placement
                  ? {
                      minWidth: 0,
                      ...placement,
                      ...(twoColumns
                        ? { height: Math.min(splitHeight, MAX_HEIGHT, Math.max(200, placement.maxHeight)) }
                        : {}),
                      maxHeight: Math.min(MAX_HEIGHT, Math.max(160, placement.maxHeight)),
                    }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
              onKeyDown={onKeyDown}
            >
              {twoColumns ? (
                <div className="agent-model-column is-agents">
                  <div className="agent-model-heading" aria-hidden="true">
                    Agent
                  </div>
                  <div
                    ref={agentsRef}
                    className="agent-model-agents picker-list"
                    id={agentsId}
                    role="listbox"
                    aria-label="Agent"
                  >
                    {agents.map((agent) => (
                      <button
                        key={agent.provider}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={agent.provider === active.provider}
                        className="picker-option agent-model-agent"
                        data-label={agent.name}
                        data-agent={agent.provider}
                        onPointerMove={(event) => {
                          hoverFocus(event);
                          setShown(agent.provider);
                        }}
                        onFocus={() => setShown(agent.provider)}
                        onClick={() => focusIn(modelsRef.current, "first")}
                      >
                        <span className="picker-option-icon" aria-hidden="true">
                          <ProviderMark provider={agent.provider} size={15} />
                        </span>
                        <span className="picker-option-text">
                          <span className="picker-option-label">{agent.name}</span>
                          {agent.plan ? <span className="picker-option-description">{agent.plan}</span> : null}
                        </span>
                        <Icon name="chevronRight" size={12} className="agent-model-chevron" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="agent-model-column is-models">
                {twoColumns ? (
                  <div className="agent-model-heading" aria-hidden="true">
                    <span>{active.name}</span>
                    {active.plan ? <span className="agent-model-plan">{active.plan}</span> : null}
                  </div>
                ) : null}
                <div
                  ref={modelsRef}
                  className="agent-model-models picker-list"
                  id={modelsId}
                  role="listbox"
                  aria-label={`${active.name} models`}
                >
                  {choices.map((option) => {
                    const selected = option.value === selectedValue;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        className="picker-option"
                        data-label={option.label}
                        onPointerMove={hoverFocus}
                        onClick={() => pick(active, option.value)}
                      >
                        <span className="picker-option-icon" aria-hidden="true">
                          {option.icon}
                        </span>
                        <span className="picker-option-text">
                          <span className="picker-option-label">{option.label}</span>
                        </span>
                        <span className="picker-option-check" aria-hidden="true">
                          {selected ? <Icon name="check" size={14} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
