import type { ProviderModelOption } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { scrollMovesAnchor, useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Icon } from "../ui/Icon.js";
import { DEFAULT_MODEL, ModelMark, modelOptions } from "../ui/ModelMark.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import type { AgentChoice } from "./agentModels.js";

type Row = AgentChoice;

/** Sizes the menu is built from. chat.css pins the rows to these, so the sum is exact. */
const TABS = 45;
const MODEL_ROW = 32;
const ROW_GAP = 1;
const LIST_PADDING = 8;
const MAX_HEIGHT = 400;

const listHeight = (rows: number, row: number) => rows * row + Math.max(0, rows - 1) * ROW_GAP;

/**
 * The agents sit in a row of marks along the top, the picked one's models in a plain list under them. Hover or
 * arrow along the marks to see another agent's models; pick a model to switch. With no other agent to offer,
 * as once a conversation has started, it is just the list of the agent's models.
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
  // Only agents that can run right now: one that is not installed or signed in is left out, not greyed.
  const agents = [own, ...others.filter((agent) => !agent.unavailable)];
  const twoColumns = agents.length > 1;
  const active = agents.find((agent) => agent.provider === shown) ?? own;
  const isOwn = active.provider === own.provider;
  const choices = modelOptions(active.models, isOwn ? model : undefined, active.provider || undefined);
  const selectedValue = isOwn ? (model ?? DEFAULT_MODEL) : undefined;
  const ownChoices = modelOptions(models, model, provider);
  // Sized for the agent with the most models, so moving between agents never resizes the menu.
  const tallest = Math.max(
    ...agents.map((agent) =>
      listHeight(
        modelOptions(agent.models, agent.provider === own.provider ? model : undefined, agent.provider || undefined)
          .length,
        MODEL_ROW,
      ),
    ),
  );
  const splitHeight = TABS + LIST_PADDING + tallest + 2;
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

  useEffect(() => {
    const row = agentsRef.current;
    if (!open || !row) return;
    const onWheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (row.scrollWidth <= row.clientWidth || delta === 0) return;
      event.preventDefault();
      row.scrollBy({ left: delta, behavior: Math.abs(delta) > 40 ? "smooth" : "auto" });
    };
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, [open]);

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
      list?.querySelector<HTMLElement>('[role="option"], button');
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
    const inAgents = list !== null && list === agentsRef.current;
    if (!list || inAgents) {
      // The marks, or the note that stands in for an agent's models when it cannot run.
      if (!twoColumns) return;
      const marks = [...(agentsRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
      const at = marks.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement | undefined;
      if (inAgents && event.key === "ArrowRight") next = marks[(at + 1) % marks.length];
      else if (inAgents && event.key === "ArrowLeft") next = marks[(at - 1 + marks.length) % marks.length];
      else if (inAgents && event.key === "ArrowDown") {
        event.preventDefault();
        focusIn(modelsRef.current, "selected");
        return;
      } else if (!list && event.key === "ArrowUp")
        next = agentsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? undefined;
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (next.dataset.agent) setShown(next.dataset.agent);
      return;
    }
    const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowUp" && index === 0 && twoColumns) {
      event.preventDefault();
      focusIn(agentsRef.current, "selected");
      return;
    }
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
                <div className="agent-model-top">
                  <div
                    ref={agentsRef}
                    className="agent-model-agents"
                    id={agentsId}
                    role="listbox"
                    aria-label="Agent"
                    aria-orientation="horizontal"
                  >
                    {agents.map((agent) => (
                      <button
                        key={agent.provider}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={agent.provider === active.provider}
                        className="agent-model-agent"
                        data-label={agent.name}
                        data-agent={agent.provider}
                        data-tooltip={[agent.name, agent.plan].filter(Boolean).join(" · ")}
                        onPointerMove={(event) => {
                          hoverFocus(event);
                          setShown(agent.provider);
                        }}
                        onFocus={() => setShown(agent.provider)}
                        onClick={() => focusIn(modelsRef.current, "first")}
                      >
                        <ProviderMark provider={agent.provider} size={16} />
                        <span className="sr-only">
                          {agent.name}
                          {agent.plan ? `, ${agent.plan}` : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="agent-model-column">
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
                        <span className="picker-option-label">{option.label}</span>
                        {selected ? (
                          <span className="agent-model-check" aria-hidden="true">
                            <Icon name="check" size={13} />
                          </span>
                        ) : null}
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
