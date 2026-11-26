import type { ProviderModelOption } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { togglePin, updateAppSettings, useAppSettings } from "../settings/appSettings.js";
import { scrollMovesAnchor, useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Icon } from "../ui/Icon.js";
import { Menu, type MenuRequest } from "../ui/Menu.js";
import { DEFAULT_MODEL, ModelMark, modelOptions } from "../ui/ModelMark.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { type AgentChoice, choiceKey } from "./agentModels.js";

type Row = AgentChoice;

/** Sizes the menu is built from. chat.css pins the rows to these, so the sum is exact. */
// The row of marks, plus the line that names the shown agent.
const TABS = 45 + 26;
const MODEL_ROW = 32;
const ROW_GAP = 1;
const LIST_PADDING = 8;
const MAX_HEIGHT = 400;

const listHeight = (rows: number, row: number) => rows * row + Math.max(0, rows - 1) * ROW_GAP;

/** Auto's place among the agents: ZLI picks the agent and model itself. */
const AUTO = "auto";

/** Auto as the first choice in the picker: ZLI picks the agent and model, at one of these levels. */
export type AutoChoice = {
  levels: readonly { value: string; label: string; description: string }[];
  /** The level picked; undefined while a set agent and model are picked instead. */
  value: string | undefined;
  onPick(level: string): void;
};

/**
 * The agents sit in a row of marks along the top, the picked one's models in a plain list under them. Hover or
 * arrow along the marks to see another agent's models; pick a model to switch. With no other agent to offer,
 * as once a conversation has started, it is just the list of the agent's models.
 */
export function AgentModelPicker({
  provider,
  agentName,
  agentPlan,
  agentAccount,
  models,
  model,
  others,
  locked,
  tooltip,
  onModelChange,
  onAgentChange,
  auto,
  prefer = "above",
  className,
  field = false,
}: {
  provider: string | undefined;
  agentName: string;
  /** The chat's own agent's plan, shown beside its name. */
  agentPlan?: string | undefined;
  /** The chat's own login, once its agent has saved accounts. */
  agentAccount?: { id: string; label: string; tag: string } | undefined;
  models: readonly ProviderModelOption[] | undefined;
  model: string | undefined;
  others: readonly AgentChoice[];
  /** The agent cannot change models inside this session. */
  locked: boolean;
  tooltip: string;
  onModelChange(model: string | undefined): void;
  onAgentChange(provider: string, model: string | undefined, accountId?: string): void;
  /** Offers Auto before the agents, for a buddy whose model ZLI may pick. */
  auto?: AutoChoice | undefined;
  /** Which side of the trigger the menu opens on when it fits there. */
  prefer?: "above" | "below";
  className?: string | undefined;
  /** Looks like a form field, full width, instead of a toolbar button. */
  field?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  const agentsId = useId();
  const modelsId = useId();
  const placement = useAnchoredPlacement(open, triggerRef, menuRef, {
    prefer,
    align: "start",
    gap: 6,
    edge: 8,
  });
  const autoRow: Row | undefined = auto
    ? { provider: AUTO as Row["provider"], name: "Auto", models: undefined, plan: undefined }
    : undefined;
  const autoOn = auto?.value !== undefined && autoRow !== undefined;
  const own: Row =
    autoOn && autoRow
      ? autoRow
      : {
          provider: (provider ?? "") as Row["provider"],
          name: agentName,
          models,
          plan: agentPlan,
          ...(agentAccount ? { accountId: agentAccount.id, account: agentAccount.label, tag: agentAccount.tag } : {}),
        };
  const isAuto = (agent: Row) => agent.provider === (AUTO as Row["provider"]);
  /** The rows under an agent's mark: Auto's levels, or the agent's models. */
  const optionsFor = (agent: Row, current: string | undefined) =>
    isAuto(agent)
      ? (auto?.levels ?? []).map((level) => ({
          value: level.value,
          label: level.label,
          icon: null,
          description: level.description,
        }))
      : modelOptions(agent.models, current, agent.provider || undefined);
  const ownKey = choiceKey(own);
  const [shown, setShown] = useState(ownKey);
  const { pinnedAgents, pinnedModels } = useAppSettings();
  // Only agents that can run right now: one that is not installed or signed in is left out, not greyed.
  // Pinned agents come first, in the order they were pinned, then the chat's own agent, then the rest.
  const runnable = [...(autoRow && !autoOn ? [autoRow] : []), own, ...others.filter((agent) => !agent.unavailable)];
  const pinRank = (agent: Row) => {
    // Auto always comes first.
    if (isAuto(agent)) return -1;
    const at = pinnedAgents.indexOf(choiceKey(agent));
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const agents = runnable
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => pinRank(a.agent) - pinRank(b.agent) || a.index - b.index)
    .map(({ agent }) => agent);
  const [pinMenu, setPinMenu] = useState<MenuRequest>();
  const toggleAgentPin = (key: string) =>
    updateAppSettings((current) => ({ ...current, pinnedAgents: togglePin(current.pinnedAgents, key) }));
  const twoColumns = agents.length > 1;
  const active = agents.find((agent) => choiceKey(agent) === shown) ?? own;
  const isOwn = choiceKey(active) === ownKey;
  const modelPin = (value: string) => `${active.provider}:${value || DEFAULT_MODEL}`;
  const allChoices = optionsFor(active, isOwn ? model : undefined);
  // Pinned models first, in pin order; the rest keep the agent's own order.
  const pinnedChoices = pinnedModels.flatMap((pin) => allChoices.filter((option) => modelPin(option.value) === pin));
  const choices = [...pinnedChoices, ...allChoices.filter((option) => !pinnedChoices.includes(option))];
  const agentPinned = pinnedAgents.includes(choiceKey(active));
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const ownValue = autoOn ? auto?.value : (model ?? DEFAULT_MODEL);
  const selectedValue = isOwn ? ownValue : undefined;
  const ownChoices = optionsFor(own, model);
  // Sized for the agent with the most models, so moving between agents never resizes the menu.
  const tallest = Math.max(
    ...agents.map((agent) =>
      listHeight(optionsFor(agent, choiceKey(agent) === ownKey ? model : undefined).length, MODEL_ROW),
    ),
  );
  const splitHeight = TABS + LIST_PADDING + tallest + 2;
  const modelLabel = ownChoices.find((option) => option.value === ownValue)?.label ?? model ?? "";
  // The default's label reads "Default · Sonnet" when the agent says which model that is.
  const shownModel =
    model || autoOn ? modelLabel : modelLabel.startsWith("Default · ") ? modelLabel.slice(10) : undefined;

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
    // The right-click menu on a mark is a popup of its own; using it must not close this one.
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target) ||
        (target instanceof Element && target.closest(".menu") !== null));
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
    // Moved directly: a smooth scroll per wheel tick is cancelled by the next tick, so the row barely moved.
    const onWheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (row.scrollWidth <= row.clientWidth || delta === 0) return;
      event.preventDefault();
      row.scrollLeft += delta;
    };
    const measure = () =>
      setOverflow((current) => {
        const left = row.scrollLeft > 1;
        const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
        return current.left === left && current.right === right ? current : { left, right };
      });
    measure();
    row.addEventListener("wheel", onWheel, { passive: false });
    row.addEventListener("scroll", measure, { passive: true });
    return () => {
      row.removeEventListener("wheel", onWheel);
      row.removeEventListener("scroll", measure);
    };
  }, [open]);

  const scrollAgents = (direction: 1 | -1) => {
    const row = agentsRef.current;
    if (row) row.scrollBy({ left: direction * row.clientWidth * 0.75, behavior: "smooth" });
  };

  const pick = (agent: Row, value: string) => {
    close(true);
    if (isAuto(agent)) {
      if (value !== auto?.value) auto?.onPick(value);
      return;
    }
    const next = value || undefined;
    if (choiceKey(agent) === ownKey) {
      if (next !== model) onModelChange(next);
    } else onAgentChange(agent.provider, next, agent.accountId);
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
        className={`${field ? "select picker-field" : "select-ghost"} picker-trigger composer-model${model || autoOn ? "" : " is-default"}${locked ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${modelLabel}`}
        aria-disabled={locked || undefined}
        data-tooltip={open ? undefined : tooltip}
        onClick={() => {
          if (locked) return;
          if (open) close(false);
          else {
            setShown(ownKey);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (locked || open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          setShown(ownKey);
          setOpen(true);
        }}
      >
        {autoOn ? (
          <Icon name="sparkle" size={14} />
        ) : (
          <ModelMark id={model} label={modelLabel} agent={provider} size={14} />
        )}
        {/* "Agent · Model" in one label; the model part is left out while the agent picks its own. */}
        <span className="picker-trigger-label">
          <span className="composer-model-agent">{own.name}</span>
          {shownModel ? (
            <>
              <span className="composer-model-dot" aria-hidden="true">
                ·
              </span>
              <span className="composer-model-name">{shownModel}</span>
            </>
          ) : null}
        </span>
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
                  {overflow.left ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="agent-model-scroll is-left"
                      aria-label="Earlier agents"
                      onClick={() => scrollAgents(-1)}
                    >
                      <Icon name="chevronRight" size={12} />
                    </button>
                  ) : null}
                  <div
                    ref={agentsRef}
                    className="agent-model-agents"
                    id={agentsId}
                    role="listbox"
                    aria-label="Agent"
                    aria-orientation="horizontal"
                  >
                    {agents.map((agent) => {
                      const key = choiceKey(agent);
                      const tooltip = [agent.name, agent.account, agent.plan].filter(Boolean).join(" · ");
                      return (
                        <button
                          key={key}
                          type="button"
                          role="option"
                          tabIndex={-1}
                          aria-selected={key === choiceKey(active)}
                          className={`agent-model-agent${pinnedAgents.includes(key) ? " is-pinned" : ""}`}
                          data-label={agent.account ? `${agent.name} ${agent.account}` : agent.name}
                          data-agent={key}
                          data-tooltip={tooltip}
                          onPointerMove={(event) => {
                            hoverFocus(event);
                            setShown(key);
                          }}
                          onFocus={() => setShown(key)}
                          onClick={() => focusIn(modelsRef.current, "first")}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            if (isAuto(agent)) return;
                            const box = event.currentTarget.getBoundingClientRect();
                            const fromKeyboard = event.clientX === 0 && event.clientY === 0;
                            const isPinned = pinnedAgents.includes(key);
                            setPinMenu({
                              x: fromKeyboard ? box.left : event.clientX,
                              y: fromKeyboard ? box.bottom : event.clientY,
                              label: `${agent.name} actions`,
                              items: [
                                {
                                  label: isPinned ? "Unpin" : "Pin to the front",
                                  icon: "pin",
                                  run: () => toggleAgentPin(key),
                                },
                              ],
                            });
                          }}
                        >
                          {pinnedAgents.includes(key) ? (
                            <span className="agent-model-pinned" aria-hidden="true">
                              <Icon name="pin" size={8} />
                            </span>
                          ) : null}
                          {isAuto(agent) ? (
                            <Icon name="sparkle" size={16} />
                          ) : (
                            <ProviderMark provider={agent.provider} size={16} />
                          )}
                          {agent.tag ? (
                            <span className="agent-model-tag" aria-hidden="true">
                              {agent.tag}
                            </span>
                          ) : null}
                          <span className="sr-only">{tooltip.replaceAll(" · ", ", ")}</span>
                        </button>
                      );
                    })}
                  </div>
                  {overflow.right ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="agent-model-scroll is-right"
                      aria-label="More agents"
                      onClick={() => scrollAgents(1)}
                    >
                      <Icon name="chevronRight" size={12} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {twoColumns ? (
                <div className="agent-model-head">
                  <span className="agent-model-head-name">
                    {isAuto(active)
                      ? "ZLI picks for each job"
                      : [active.name, active.account, active.plan].filter(Boolean).join(" · ")}
                  </span>
                  {isAuto(active) ? null : (
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`agent-model-pin${agentPinned ? " is-on" : ""}`}
                      aria-pressed={agentPinned}
                      aria-label={agentPinned ? `Unpin ${active.name}` : `Pin ${active.name}`}
                      data-tooltip={agentPinned ? "Unpin agent" : "Pin agent to the front"}
                      onClick={() => toggleAgentPin(choiceKey(active))}
                    >
                      <Icon name="pin" size={12} />
                    </button>
                  )}
                </div>
              ) : null}
              <div className="agent-model-column">
                <div
                  ref={modelsRef}
                  className="agent-model-models picker-list"
                  id={modelsId}
                  role="listbox"
                  aria-label={`${[active.name, active.account].filter(Boolean).join(", ")} models`}
                >
                  {choices.map((option, index) => {
                    const selected = option.value === selectedValue;
                    const pinKey = modelPin(option.value);
                    const pinned = pinnedModels.includes(pinKey);
                    const lastPinned =
                      pinned && index === pinnedChoices.length - 1 && choices.length > pinnedChoices.length;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        className={`picker-option${pinned ? " is-pinned" : ""}${lastPinned ? " is-last-pinned" : ""}`}
                        data-label={option.label}
                        data-tooltip={"description" in option ? option.description : undefined}
                        onPointerMove={hoverFocus}
                        onClick={() => pick(active, option.value)}
                      >
                        <span className="picker-option-icon" aria-hidden="true">
                          {option.icon}
                        </span>
                        <span className="picker-option-label">{option.label}</span>
                        {/* Not a button inside a button: a span that takes the click before the row does. */}
                        {isAuto(active) ? null : (
                          // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the row stays the option.
                          <span
                            className={`agent-model-pin is-row${pinned ? " is-on" : ""}`}
                            role="presentation"
                            data-tooltip={pinned ? "Unpin model" : "Pin model to the top"}
                            onClick={(event) => {
                              event.stopPropagation();
                              updateAppSettings((current) => ({
                                ...current,
                                pinnedModels: togglePin(current.pinnedModels, pinKey),
                              }));
                            }}
                          >
                            <Icon name="pin" size={12} />
                          </span>
                        )}
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
      {open && pinMenu ? <Menu request={pinMenu} onClose={() => setPinMenu(undefined)} /> : null}
    </>
  );
}
