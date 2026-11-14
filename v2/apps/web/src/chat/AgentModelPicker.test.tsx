// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentModelPicker } from "./AgentModelPicker.js";
import type { AgentChoice } from "./agentModels.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
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

function open(onAgentChange = vi.fn()) {
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
        others={OTHERS}
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
    expect(onAgentChange).toHaveBeenCalledWith("claude-code", "opus");
  });
});
