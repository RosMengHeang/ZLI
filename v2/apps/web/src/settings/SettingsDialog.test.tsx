// @vitest-environment jsdom

import type { RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPlanLimitsStore } from "../limits/limits.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { DEFAULT_SETTINGS, readAppSettings, updateAppSettings } from "./appSettings.js";
import { matchingSections, SettingsDialog, settingsPageFor } from "./SettingsDialog.js";

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
    expect(matchingSections("workspace").map((entry) => entry.id)).toEqual(["projects", "worktrees"]);
    // Settings that moved into General are still found by the words people use for them.
    expect(matchingSections("notifications").map((entry) => entry.id)).toEqual(["general"]);
    expect(matchingSections("file tree").map((entry) => entry.id)).toEqual(["general"]);
    expect(matchingSections("branch template").map((entry) => entry.id)).toEqual(["worktrees"]);
    expect(matchingSections("plan limits").map((entry) => entry.id)).toContain("accounts");
    expect(matchingSections("nothing like this")).toEqual([]);
  });
});

describe("SettingsDialog", () => {
  it("groups the pages, opens on General, and titles the open page", async () => {
    const container = await render();
    const headings = [...container.querySelectorAll(".settings-nav-heading")].map((node) => node.textContent);
    expect(headings).toEqual(["App", "Agents", "Projects", "Tools"]);
    expect(tabs(container)[0]).toBe("General");
    expect(tabs(container)).toContain("Mobile");
    expect(tabs(container)).not.toContain("Notifications");
    expect(container.querySelector(".settings-page-title")?.textContent).toBe("General");
    const groups = [...container.querySelectorAll(".settings-group-title")].map((node) => node.textContent);
    expect(groups).toEqual(["New agents", "Chats", "Notifications", "Files"]);
    const mobile = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "Mobile",
    );
    await act(async () => mobile?.click());
    expect(mobile?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".settings-page-title")?.textContent).toBe("Mobile");
  });

  it("opens the pages that moved into General from their old names", async () => {
    expect(settingsPageFor("agents")).toBe("general");
    expect(settingsPageFor("files")).toBe("general");
    expect(settingsPageFor("notifications")).toBe("general");
    expect(settingsPageFor("issues")).toBe("forges");
    expect(settingsPageFor("usage")).toBe("usage");
  });

  it("moves between pages with the arrow keys", async () => {
    const container = await render();
    const first = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    first?.focus();
    await act(async () => {
      first?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const selected = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe("Appearance");
    expect(document.activeElement).toBe(selected);
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

describe("Usage in the sidebar, on the Providers page", () => {
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
            initialSection="accounts"
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

  it("is on by default and lists only the agents with a plan that reports limits", async () => {
    const container = await openUsage([
      ok("claude-code"),
      { provider: "codex", accountId: "usual", state: "error", windows: [] },
      { provider: "opencode", accountId: "usual", state: "expired", windows: [] },
      ok("gemini", "work"),
    ]);
    expect(container.querySelector(".settings-page-title")?.textContent).toBe("Providers");
    const groups = [...container.querySelectorAll(".settings-group-title")].map((node) => node.textContent);
    expect(groups).toEqual(expect.arrayContaining(["Usage in the sidebar", "Claude context"]));
    expect(switches(container).map(({ input: _input, ...rest }) => rest)).toEqual([
      { label: "Show plan limits", checked: true, disabled: false },
      { label: "Claude Code", checked: true, disabled: false },
      { label: "Gemini", checked: true, disabled: false },
      { label: "Compact chats automatically", checked: true, disabled: false },
    ]);
  });

  it("turns automatic compacting off and back on", async () => {
    const container = await openUsage([ok("claude-code")]);
    const compacting = () => switches(container).find((entry) => entry.label === "Compact chats automatically");
    await act(async () => compacting()?.input.click());
    expect(readAppSettings().autoCompact).toEqual({ enabled: false, at: 0.85 });
    expect(
      container.querySelector('[aria-label="Compact when context reaches: 85%"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => compacting()?.input.click());
    expect(readAppSettings().autoCompact).toEqual({ enabled: true, at: 0.85 });
  });

  it("turns the card off and on, and hides one agent", async () => {
    const container = await openUsage([ok("claude-code"), ok("codex")]);
    await act(async () => switches(container)[0]?.input.click());
    expect(readAppSettings().sidebarLimits).toEqual({ enabled: false, hidden: [] });
    expect(switches(container).find((entry) => entry.label === "Codex")?.disabled).toBe(true);
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
    expect(switches(container).map((entry) => entry.label)).toEqual([
      "Show plan limits",
      "Compact chats automatically",
    ]);
  });
});

describe("Projects page", () => {
  const projection = {
    projects: [
      { projectId: "00000000-0000-4000-8000-000000000a01", name: "web", path: "C:/code/web" },
      { projectId: "00000000-0000-4000-8000-000000000a02", name: "api", path: "C:/code/api" },
    ],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    providers: [],
    lastSequence: 1,
  } as unknown as RuntimeProjection;

  async function openProjects(onRemoveProject = vi.fn(async () => undefined)) {
    const commands: Record<string, unknown>[] = [];
    const dispatch = vi.fn(async (request: { commandId: string; command: Record<string, unknown> }) => {
      commands.push(request.command);
      const result =
        request.command.type === "project.config"
          ? { status: "valid", config: { version: 1, worktree: { copy: [".env"], setup: ["pnpm install"] } } }
          : {};
      return { commandId: request.commandId, accepted: true, result };
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RuntimeProvider bridge={{ runtime: { ...bridge.runtime, dispatch } } as unknown as ZliBridge}>
          <SettingsDialog
            projection={projection}
            initialSection="projects"
            notifications={{ settings: undefined, update: () => undefined }}
            onRemoveProject={onRemoveProject}
            onClose={() => undefined}
          />
        </RuntimeProvider>,
      );
    });
    return { container, onRemoveProject, commands };
  }

  const buttonNamed = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
    );
  const groupTitles = (container: HTMLElement) =>
    [...container.querySelectorAll(".settings-group-title")].map((node) => node.textContent);

  it("lists the folders, and opening one shows its own page", async () => {
    const { container } = await openProjects();
    expect([...container.querySelectorAll(".project-name")].map((node) => node.textContent)).toEqual(["web", "api"]);
    expect(groupTitles(container)).toEqual(["Folders"]);
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".project-open")[1]?.click());
    expect(container.querySelector(".settings-page-title")?.textContent).toBe("api");
    expect(groupTitles(container)).toEqual(["Project", "New worktrees", "Agent defaults", "Remove"]);
    const codes = [...container.querySelectorAll(".project-config-list code")].map((node) => node.textContent);
    expect(codes).toEqual([".env", "pnpm install"]);
    await act(async () => container.querySelector<HTMLButtonElement>(".project-page-back button")?.click());
    expect(container.querySelector(".settings-page-title")?.textContent).toBe("Projects");
  });

  it("renames a project from its page", async () => {
    const { container, commands } = await openProjects();
    await act(async () => container.querySelector<HTMLButtonElement>(".project-open")?.click());
    const input = container.querySelector<HTMLInputElement>(".setting-row input.input");
    expect(input?.value).toBe("web");
    await act(async () => {
      if (input) type(input, "website");
      input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(commands.at(-1)).toEqual({
      type: "project.rename",
      projectId: "00000000-0000-4000-8000-000000000a01",
      name: "website",
    });
  });

  it("asks before removing, then goes back to the list", async () => {
    const { container, onRemoveProject } = await openProjects();
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".project-open")[1]?.click());
    await act(async () => buttonNamed(container, "Remove")?.click());
    expect(container.querySelector(".project-remove-title")?.textContent).toBe("Remove api from ZLI?");
    expect(onRemoveProject).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll<HTMLButtonElement>(".project-remove-actions button")].at(-1);
    await act(async () => confirm?.click());
    expect(onRemoveProject).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000a02");
    expect(container.querySelector(".settings-done")?.textContent).toContain("Removed api from ZLI.");
  });
});

describe("Worktrees page", () => {
  async function openWorktrees() {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RuntimeProvider bridge={bridge}>
          <SettingsDialog
            projection={undefined}
            initialSection="worktrees"
            notifications={{ settings: undefined, update: () => undefined }}
            onClose={() => undefined}
          />
        </RuntimeProvider>,
      );
    });
    return container;
  }

  const switchNamed = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find(
      (input) => input.closest("label")?.querySelector(".switch-label")?.textContent === label,
    );

  it("saves where worktrees go, where they start, and how they are cleaned up", async () => {
    const container = await openWorktrees();

    const location = container.querySelector<HTMLInputElement>('input[placeholder="Next to each project"]');
    await act(async () => {
      if (location) type(location, "relative/path");
    });
    expect(readAppSettings().worktrees.location).toBeUndefined();
    expect(container.textContent).toContain("Use a full path");
    await act(async () => {
      if (location) type(location, "D:/worktrees");
    });
    expect(readAppSettings().worktrees.location).toBe("D:/worktrees");

    await act(async () => switchNamed(container, "Start from the remote")?.click());
    expect(readAppSettings().worktrees.fromRemote).toBe(true);
    await act(async () => switchNamed(container, "Remove the worktree with its agent")?.click());
    expect(readAppSettings().worktrees.removeWithAgent).toBe(true);
  });

  it("adds a part to the branch template when its button is clicked", async () => {
    updateAppSettings((current) => ({ ...current, branchTemplate: "zli/{agent}" }));
    const container = await openWorktrees();
    const date = [...container.querySelectorAll<HTMLButtonElement>(".branch-token")].find(
      (button) => button.textContent === "{date}",
    );
    await act(async () => date?.click());
    expect(readAppSettings().branchTemplate).toBe("zli/{agent}-{date}");
    expect(date?.disabled).toBe(true);
  });
});
