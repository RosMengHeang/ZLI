// @vitest-environment jsdom

import type { BuddyEngine, ProviderDiscovery } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuddyModelPicker } from "./BuddyModelPicker.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const PROVIDERS = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    status: "found",
    path: "claude",
    login: { status: "signed-in" },
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    ],
  },
] as unknown as ProviderDiscovery[];

function open(engine: BuddyEngine) {
  const onChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  act(() =>
    createRoot(host).render(
      <BuddyModelPicker engine={engine} providers={PROVIDERS} teamQuality="balanced" onChange={onChange} />,
    ),
  );
  const trigger = host.querySelector<HTMLButtonElement>(".composer-model");
  act(() => trigger?.click());
  return { onChange, trigger };
}

const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.agent-model-models [role="option"]')].find(
    (entry) => entry.dataset.label === label,
  );

describe("BuddyModelPicker", () => {
  it("opens on Auto at the team's level, with its three levels", () => {
    const { trigger } = open({ mode: "auto" });
    expect(trigger?.textContent).toContain("Auto");
    expect(trigger?.textContent).toContain("Balanced");
    expect(
      [...document.querySelectorAll<HTMLElement>('.agent-model-models [role="option"]')].map(
        (entry) => entry.dataset.label,
      ),
    ).toEqual(["Budget", "Balanced", "Best"]);
  });

  it("picks an Auto level", () => {
    const { onChange } = open({ mode: "auto" });
    act(() => option("Best")?.click());
    expect(onChange).toHaveBeenCalledWith({ mode: "auto", quality: "best" });
  });

  it("locks the buddy to a model picked under its agent", () => {
    const { onChange } = open({ mode: "auto", quality: "save" });
    const claude = [...document.querySelectorAll<HTMLElement>(".agent-model-agent")].find(
      (row) => row.dataset.label === "Claude Code",
    );
    act(() => claude?.dispatchEvent(new FocusEvent("focus")));
    act(() => claude?.focus());
    act(() => option("Opus 5.5")?.click());
    expect(onChange).toHaveBeenCalledWith({ mode: "locked", provider: "claude-code", model: "claude-opus-5-5" });
  });

  it("shows a locked model, with Auto still first among the agents", () => {
    const { trigger } = open({ mode: "locked", provider: "claude-code", model: "claude-sonnet-5-5" });
    expect(trigger?.textContent).toContain("Sonnet 5.5");
    expect(document.querySelector<HTMLElement>(".agent-model-agent")?.dataset.label).toBe("Auto");
  });
});
