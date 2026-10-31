// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPlanLimitsStore } from "../limits/limits.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { DEFAULT_SETTINGS, readAppSettings, updateAppSettings } from "./appSettings.js";
import { matchingSections, SettingsDialog } from "./SettingsDialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  updateAppSettings(() => structuredClone(DEFAULT_SETTINGS));
});

const bridge = {
  runtime: { getProjection: async () => undefined, onProjection: () => () => undefined },
} as unknown as ZliBridge;

async function render(onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <SettingsDialog
          projection={undefined}
          notifications={{ settings: undefined, update: () => undefined }}
          onClose={onClose}
        />
      </RuntimeProvider>,
    );
  });
  return container;
}

function tabs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "");
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("matchingSections", () => {
  it("finds sections by label, group, and the words people use for them", () => {
    expect(matchingSections("").length).toBeGreaterThan(10);
    expect(matchingSections("emulator").map((entry) => entry.id)).toEqual(["mobile"]);
    expect(matchingSections("MCP").map((entry) => entry.id)).toEqual(["integrations"]);
    expect(matchingSections("workspace").map((entry) => entry.id)).toEqual(["projects", "worktrees", "files"]);
    expect(matchingSections("branch template").map((entry) => entry.id)).toEqual(["worktrees"]);
    expect(matchingSections("plan limits").map((entry) => entry.id)).toEqual(["usage"]);
    expect(matchingSections("nothing like this")).toEqual([]);
  });
});

describe("SettingsDialog", () => {
  it("groups the sections, and names the open one in the breadcrumb", async () => {
    const container = await render();
    const headings = [...container.querySelectorAll(".settings-nav-heading")].map((node) => node.textContent);
    expect(headings).toEqual(["Agents", "Workspace", "Tools", "App"]);
    expect(tabs(container)).toContain("Mobile");
    expect(container.querySelector(".settings-crumbs")?.textContent).toBe("AgentsNew agents");
    const mobile = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "Mobile",
    );
    await act(async () => mobile?.click());
    expect(mobile?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".settings-crumbs")?.textContent).toBe("ToolsMobile");
  });

  it("filters the section list as you type, opens the first match on Enter, and clears on Escape", async () => {
    const onClose = vi.fn();
    const container = await render(onClose);
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    if (!search) throw new Error("No search field");
    await act(async () => type(search, "android"));
    expect(tabs(container)).toEqual(["Mobile"]);
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Mobile");

    await act(async () => type(search, "zzz"));
    expect(tabs(container)).toEqual([]);
    expect(container.querySelector(".settings-nav-empty")?.textContent).toBe("Nothing matches zzz.");

    const escapeKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);
    await act(async () => {
      search.dispatchEvent(escapeKey);
    });
    window.removeEventListener("keydown", reachedWindow);
    expect(search.value).toBe("");
    // The shell closes Settings on Escape, so clearing the search must keep the key from reaching it.
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(tabs(container).length).toBeGreaterThan(10);
  });
});

describe("Usage settings", () => {
  const ok = (provider: string, accountId = "usual") => ({
    provider,
    accountId,
    state: "ok",
    windows: [{ durationMinutes: 300, usedPercent: 20 }],
  });

  async function openUsage(readings: unknown[]) {
    resetPlanLimitsStore();
    const dispatch = vi.fn(async (request: { commandId: string }) => ({
      commandId: request.commandId,
      accepted: true,
      result: { readings },
    }));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RuntimeProvider bridge={{ runtime: { ...bridge.runtime, dispatch } } as unknown as ZliBridge}>
          <SettingsDialog
            projection={undefined}
            initialSection="usage"
            notifications={{ settings: undefined, update: () => undefined }}
            onClose={() => undefined}
          />
        </RuntimeProvider>,
      );
    });
    return container;
  }

  const switches = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')].map((input) => ({
      label: input.closest("label")?.querySelector(".switch-label")?.textContent,
      checked: input.checked,
      disabled: input.disabled,
      input,
    }));

  it("is off by default and lists only the agents with a plan that reports limits", async () => {
    const container = await openUsage([
      ok("claude-code"),
      { provider: "codex", accountId: "usual", state: "error", windows: [] },
      { provider: "opencode", accountId: "usual", state: "expired", windows: [] },
      ok("gemini", "work"),
    ]);
    expect(switches(container).map(({ input: _input, ...rest }) => rest)).toEqual([
      { label: "Show plan limits", checked: false, disabled: false },
      { label: "Claude Code", checked: true, disabled: true },
      { label: "Gemini", checked: true, disabled: true },
    ]);
  });

  it("turns the card on and hides one agent", async () => {
    const container = await openUsage([ok("claude-code"), ok("codex")]);
    await act(async () => switches(container)[0]?.input.click());
    expect(readAppSettings().sidebarLimits).toEqual({ enabled: true, hidden: [] });
    const codex = switches(container).find((entry) => entry.label === "Codex");
    expect(codex?.disabled).toBe(false);
    await act(async () => codex?.input.click());
    expect(readAppSettings().sidebarLimits).toEqual({ enabled: true, hidden: ["codex"] });
  });

  it("pins one agent to the footer line, and Automatic lets it follow the selected agent again", async () => {
    const container = await openUsage([ok("claude-code"), ok("codex")]);
    const picker = () => container.querySelector<HTMLButtonElement>('[aria-label^="Agent in the footer"]');
    const choose = async (label: string) => {
      await act(async () => picker()?.click());
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (entry) => entry.textContent === label,
      );
      await act(async () => option?.click());
    };
    expect(picker()?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => switches(container)[0]?.input.click());
    expect(picker()?.getAttribute("aria-label")).toBe("Agent in the footer: Automatic");

    await choose("Codex");
    expect(readAppSettings().sidebarLimits).toEqual({ enabled: true, hidden: [], pinned: "codex" });
    // Switching the pinned agent off shows Automatic, and switching it back on brings the pin back.
    const codex = () => switches(container).find((entry) => entry.label === "Codex")?.input;
    await act(async () => codex()?.click());
    expect(picker()?.getAttribute("aria-label")).toBe("Agent in the footer: Automatic");
    await act(async () => codex()?.click());
    expect(picker()?.getAttribute("aria-label")).toBe("Agent in the footer: Codex");

    await choose("Automatic");
    expect(readAppSettings().sidebarLimits).toEqual({ enabled: true, hidden: [] });
  });

  it("says so when no agent reports plan limits", async () => {
    const container = await openUsage([{ provider: "codex", accountId: "usual", state: "signed-out", windows: [] }]);
    expect(container.querySelector(".settings-panel")?.textContent).toContain("None of your agents report plan limits");
    expect(switches(container)).toHaveLength(1);
  });
});
