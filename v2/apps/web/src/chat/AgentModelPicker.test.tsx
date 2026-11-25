// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, updateAppSettings } from "../settings/appSettings.js";
import { AgentModelPicker } from "./AgentModelPicker.js";
import type { AgentChoice } from "./agentModels.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
  updateAppSettings((current) => ({ ...current, pinnedAgents: [], pinnedModels: [] }));
});

const OTHERS: AgentChoice[] = [
  { provider: "claude-code", name: "Claude Code", models: [{ id: "opus", label: "Opus" }], plan: "Max" },
  {
    provider: "cursor-agent",
    name: "Cursor",
    models: [{ id: "auto", label: "Auto" }],
    plan: undefined,
    unavailable: "Not signed in",
  },
  { provider: "gemini", name: "Gemini", models: undefined, plan: undefined, unavailable: "Not installed" },
];

function open(onAgentChange = vi.fn(), others: AgentChoice[] = OTHERS) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <AgentModelPicker
        provider="codex"
        agentName="Codex"
        models={[{ id: "gpt-5", label: "GPT-5" }]}
        model={undefined}
        others={others}
        locked={false}
        tooltip="Pick"
        onModelChange={() => undefined}
        onAgentChange={onAgentChange}
      />,
    ),
  );
  act(() => host.querySelector<HTMLButtonElement>(".composer-model")?.click());
  return onAgentChange;
}

const agentRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".agent-model-agent")].find((row) => row.dataset.label === name);

describe("AgentModelPicker", () => {
  it("offers only the agents that can run", () => {
    open();
    expect(agentRow("Codex")).toBeDefined();
    expect(agentRow("Claude Code")?.textContent).toContain("Max");
    expect(agentRow("Cursor")).toBeUndefined();
    expect(agentRow("Gemini")).toBeUndefined();
  });

  it("still switches to an agent that can run", () => {
    const onAgentChange = open();
    act(() => agentRow("Claude Code")?.focus());
    const opus = [...document.querySelectorAll<HTMLButtonElement>('.agent-model-models [role="option"]')].find(
      (option) => option.dataset.label === "Opus",
    );
    act(() => opus?.click());
    expect(onAgentChange).toHaveBeenCalledWith("claude-code", "opus", undefined);
  });

  it("lists each account of an agent with its tag, and picks the account with the model", () => {
    const work = { provider: "claude-code", name: "Claude Code", models: [{ id: "opus", label: "Opus" }], plan: "Max" };
    const onAgentChange = open(vi.fn(), [
      { ...work, accountId: "usual", account: "Usual login", tag: "U" } as AgentChoice,
      { ...work, accountId: "acc-work", account: "Work", tag: "W" } as AgentChoice,
    ]);
    const row = agentRow("Claude Code Work");
    expect(row?.querySelector(".agent-model-tag")?.textContent).toBe("W");
    expect(row?.dataset.tooltip).toBe("Claude Code · Work · Max");
    act(() => row?.focus());
    const opus = [...document.querySelectorAll<HTMLButtonElement>('.agent-model-models [role="option"]')].find(
      (option) => option.dataset.label === "Opus",
    );
    act(() => opus?.click());
    expect(onAgentChange).toHaveBeenCalledWith("claude-code", "opus", "acc-work");
  });

  it("pins an agent to the front and a model to the top of its list", () => {
    const others: AgentChoice[] = [
      { provider: "claude-code", name: "Claude Code", models: [{ id: "opus", label: "Opus" }], plan: "Max" },
      {
        provider: "grok",
        name: "Grok",
        models: [
          { id: "fast", label: "Fast" },
          { id: "heavy", label: "Heavy" },
        ],
        plan: undefined,
      },
    ];
    open(vi.fn(), others);
    const order = () =>
      [...document.querySelectorAll<HTMLElement>(".agent-model-agent")].map((row) => row.dataset.label);
    expect(order()).toEqual(["Codex", "Claude Code", "Grok"]);

    act(() => agentRow("Grok")?.focus());
    act(() => document.querySelector<HTMLButtonElement>(".agent-model-head .agent-model-pin")?.click());
    expect(order()).toEqual(["Grok", "Codex", "Claude Code"]);
    expect(agentRow("Grok")?.querySelector(".agent-model-pinned")).not.toBeNull();

    // Right-click pins too, as many as you like, in the order pinned.
    act(() => {
      agentRow("Claude Code")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
      );
    });
    const pinItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Pin to the front",
    );
    act(() => pinItem?.click());
    expect(order()).toEqual(["Grok", "Claude Code", "Codex"]);
    expect(document.querySelector(".agent-model-menu")).not.toBeNull();

    act(() => agentRow("Grok")?.focus());
    const models = () =>
      [...document.querySelectorAll<HTMLElement>('.agent-model-models [role="option"]')].map(
        (row) => row.dataset.label,
      );
    const heavy = [...document.querySelectorAll<HTMLElement>('.agent-model-models [role="option"]')].find(
      (row) => row.dataset.label === "Heavy",
    );
    act(() => heavy?.querySelector<HTMLElement>(".agent-model-pin")?.click());
    expect(models().slice(0, 2)).toEqual(["Heavy", expect.any(String)]);
    expect(DEFAULT_SETTINGS.pinnedModels).toEqual([]);
  });
});
