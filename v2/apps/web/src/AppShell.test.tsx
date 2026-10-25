// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  type UpdateStatus,
  type WhatsNew,
  WorktreeId,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZliBridge } from "./runtime/bridge.js";
import { DEFAULT_SETTINGS, updateAppSettings } from "./settings/appSettings.js";
import { AppShell } from "./shell/AppShell.js";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    reset(): void {}
    onData() {
      return { dispose: () => undefined };
    }
    registerLinkProvider() {
      return { dispose: () => undefined };
    }
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");

const projection: RuntimeProjection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: { worktrees: true, terminals: true, browser: true, eventReplay: true },
  },
  projects: [{ projectId, path: "C:/repo", name: "repo" }],
  worktrees: [{ worktreeId, projectId, path: "C:/repo", branch: "main", status: "ready" }],
  threads: [],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 1,
};

const discovered: RuntimeProjection = {
  ...projection,
  providers: [
    { provider: "codex", displayName: "Codex", status: "missing", reason: "Codex CLI was not found." },
    {
      provider: "claude-code",
      displayName: "Claude Code",
      status: "found",
      path: "/home/dev/.local/bin/claude",
      version: "claude 2.1.0",
    },
  ],
};

const agentSessionId = "00000000-0000-4000-8000-000000000201";
const agentTerminalId = "00000000-0000-4000-8000-000000000301";

const withAgent: RuntimeProjection = {
  ...discovered,
  terminals: [
    {
      terminalId: agentTerminalId,
      worktreeId,
      title: "Claude Code",
      status: "running",
      kind: "agent",
      agent: { provider: "claude-code", permissionMode: "full-access" },
      sessionId: agentSessionId,
    } as RuntimeProjection["terminals"][number],
  ],
};

function commands(dispatched: unknown[]): Record<string, unknown>[] {
  return dispatched.map((request) => (request as { command: Record<string, unknown> }).command);
}

function firstBrowserTab() {
  const browserTab = projection.browserTabs[0];
  if (!browserTab) throw new Error("The test projection has no browser tab.");
  return browserTab;
}

let revealListener: ((event: { browserTabId: string; worktreeId: string }) => void) | undefined;

function makeBridge(current: RuntimeProjection, dispatched: unknown[] = []): ZliBridge {
  return {
    runtime: {
      dispatch: async (request: unknown) => {
        dispatched.push(request);
        return { commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true as const };
      },
      getProjection: async () => current,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
    browser: {
      create: async () => firstBrowserTab(),
      close: async () => undefined,
      activate: async () => firstBrowserTab(),
      navigate: async () => firstBrowserTab(),
      hide: async () => undefined,
      setBounds: async () => undefined,
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
      stop: async () => undefined,
      openDevTools: async () => undefined,
      setViewport: async () => firstBrowserTab(),
      onReveal: (listener) => {
        revealListener = listener;
        return () => {
          revealListener = undefined;
        };
      },
      snapshot: async () => undefined,
      click: async () => undefined,
      fill: async () => undefined,
      press: async () => undefined,
      waitForNetworkIdle: async () => ({ idle: true }),
      screenshot: async () => undefined,
      inspectElement: async () => undefined,
      designInspect: async () => undefined,
      consoleEntries: async () => [],
      networkEntries: async () => [],
    },
    dialog: {
      openProject: async () => undefined,
      saveSupportBundle: async () => undefined,
      openLegacySnapshot: async () => undefined,
    },
    menu: { trigger: async () => undefined },
    app: { getVersion: async () => "0.0.0", quit: async () => undefined },
  };
}

async function render(bridge: ZliBridge) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<AppShell bridge={bridge} />);
  });
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
}

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("AppShell", () => {
  it("shows the project, an empty agent board, and a terminal drawer on demand", async () => {
    const container = await render(makeBridge(projection));
    expect(container.querySelector(".project-label")?.textContent).toContain("repo");
    expect(container.textContent).toContain("main");
    expect(container.textContent).toContain("No agents on the board");
    expect(container.querySelector('[aria-label="Terminal panel"]')).toBeNull();
    await act(async () => {
      button(container, "Terminal")?.click();
    });
    expect(container.querySelector('[aria-label="Terminal panel"]')).not.toBeNull();
    expect(button(container, "Start terminal")).not.toBeUndefined();
  });

  it("provides a keyboard-accessible command palette with working pane actions", async () => {
    const container = await render(makeBridge(projection));
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".command-trigger")?.click();
    });
    const browserAction = button(container, "Focus browser");
    expect(browserAction).not.toBeUndefined();
    await act(async () => {
      browserAction?.click();
    });
    expect(container.querySelector('[aria-label="Browser panel"]')).not.toBeNull();
    expect(button(container, "Browser")?.classList.contains("is-active")).toBe(true);
  });

  it("opens the Browser panel when an agent opens a page", async () => {
    const container = await render(makeBridge(projection));
    expect(container.querySelector('[aria-label="Browser panel"]')).toBeNull();
    await act(async () => {
      revealListener?.({ browserTabId: "00000000-0000-4000-8000-000000000021", worktreeId });
    });
    expect(container.querySelector('[aria-label="Browser panel"]')).not.toBeNull();
    expect(button(container, "Browser")?.classList.contains("is-active")).toBe(true);
  });

  it("filters palette commands and closes the palette before opening help", async () => {
    const container = await render(makeBridge(projection));
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".command-trigger")?.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "help");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Help and diagnostics");
    expect(container.textContent).not.toContain("Focus agent");
    await act(async () => {
      button(container, "Help and diagnostics")?.click();
    });
    expect(container.querySelector('[aria-label="Command palette"]')).toBeNull();
    expect(container.querySelector('[aria-label="Help and diagnostics"]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[aria-label="Help and diagnostics"]')).toBeNull();
  });

  it("starts a new agent CLI in a terminal tile in the chosen worktree", async () => {
    const dispatched: unknown[] = [];
    const container = await render(makeBridge(discovered, dispatched));
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".sidebar-new-agent")?.click();
    });
    const dialog = container.querySelector('[role="dialog"][aria-label="New agent"]');
    expect(dialog).not.toBeNull();
    const claude = dialog?.querySelector<HTMLInputElement>('input[value="claude-code"]');
    expect(claude?.checked).toBe(true);
    expect(dialog?.querySelector('input[value="codex"]')).toBeNull();
    await act(async () => {
      button(container, "Show 1 not installed")?.click();
    });
    expect(dialog?.querySelector<HTMLInputElement>('input[value="codex"]')?.disabled).toBe(true);
    await act(async () => {
      button(container, "Start agent")?.click();
    });
    expect(container.querySelector('[aria-label="New agent"][role="dialog"]')).toBeNull();
    const create = dispatched
      .map((request) => (request as { command: Record<string, unknown> }).command)
      .find((command) => command.type === "terminal.create");
    expect(create).toMatchObject({
      worktreeId,
      cwd: "C:/repo",
      agent: { provider: "claude-code", permissionMode: "full-access" },
    });
    expect(typeof create?.sessionId).toBe("string");
    expect(container.querySelector(".agent-tile")?.textContent).toContain("Claude Code");
  });

  it("shows running agent terminals as tiles and sidebar rows grouped under the project", async () => {
    const container = await render(makeBridge(withAgent));
    expect(container.querySelectorAll(".agent-tile")).toHaveLength(1);
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Claude Code terminal"]')).not.toBeNull());
    // The view is chosen when the agent starts, so the tile has no Terminal or Chat switch.
    expect(container.querySelector('.agent-tile [aria-label="Chat view"]')).toBeNull();
    expect(container.querySelector(".session-row")?.getAttribute("aria-label")).toBe("Claude Code, Claude Code, Ready");
    await act(async () => {
      button(container, "Close tile")?.click();
    });
    expect(container.querySelector('[role="dialog"][aria-label="Close agent"]')).not.toBeNull();
    await act(async () => {
      button(container, "Keep running")?.click();
    });
    expect(container.querySelectorAll(".agent-tile")).toHaveLength(0);
    expect(container.textContent).toContain("Pick an agent in the sidebar");
    expect(container.querySelector(".session-row")?.getAttribute("aria-label")).toBe(
      "Claude Code, Claude Code, Ready, in the background",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".session-row")?.click();
    });
    expect(container.querySelectorAll(".agent-tile")).toHaveLength(1);
  });

  it("stops the agent when closing its tile with Stop and close", async () => {
    const dispatched: unknown[] = [];
    const container = await render(makeBridge(withAgent, dispatched));
    await act(async () => {
      button(container, "Close tile")?.click();
    });
    await act(async () => {
      button(container, "Stop and close")?.click();
    });
    expect(container.querySelectorAll(".agent-tile")).toHaveLength(0);
    expect(commands(dispatched)).toContainEqual({ type: "terminal.stop", terminalId: agentTerminalId });
  });

  it("deletes a running agent for good", async () => {
    const dispatched: unknown[] = [];
    const container = await render(makeBridge(withAgent, dispatched));
    await act(async () => {
      button(container, "Delete Claude Code")?.click();
    });
    const dialog = container.querySelector('[role="dialog"][aria-label="Delete agent"]');
    expect(dialog?.textContent).toContain("Stops Claude Code");
    await act(async () => {
      button(container, "Delete agent")?.click();
    });
    expect(container.querySelector('[role="dialog"][aria-label="Delete agent"]')).toBeNull();
    const sent = commands(dispatched);
    expect(sent).toContainEqual({ type: "session.delete", sessionId: agentSessionId });
    expect(sent.some((command) => command.type === "worktree.remove")).toBe(false);
  });

  it("deletes a stopped agent with its worktree when asked", async () => {
    const dispatched: unknown[] = [];
    const stopped: RuntimeProjection = {
      ...withAgent,
      terminals: withAgent.terminals.map((terminal) => ({ ...terminal, status: "exited" as const })),
    };
    const container = await render(makeBridge(stopped, dispatched));
    await act(async () => {
      button(container, "Delete Claude Code")?.click();
    });
    const dialog = container.querySelector('[role="dialog"][aria-label="Delete agent"]');
    expect(dialog?.textContent).not.toContain("Stops");
    const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => {
      checkbox?.click();
    });
    await act(async () => {
      button(container, "Delete agent and worktree")?.click();
    });
    expect(container.querySelector('[role="dialog"][aria-label="Delete agent"]')).toBeNull();
    const sent = commands(dispatched);
    expect(sent).toContainEqual({ type: "session.delete", sessionId: agentSessionId });
    expect(sent).toContainEqual({ type: "worktree.remove", worktreeId, force: true });
    expect(sent.findIndex((command) => command.type === "session.delete")).toBeLessThan(
      sent.findIndex((command) => command.type === "worktree.remove"),
    );
  });

  it("asks before a plugin action runs a command, then remembers the approval", async () => {
    const dispatched: unknown[] = [];
    const bridge = makeBridge(projection, dispatched);
    const action = { plugin: "kit", name: "Test", description: "", command: "npm test" };
    const kit = {
      name: "kit",
      displayName: "Kit",
      description: "",
      format: "claude",
      enabled: true,
      path: "/data/plugins/kit",
      source: "https://github.com/acme/kit",
      installedAt: "2025-01-01T00:00:00.000Z",
      components: { skills: [], mcpServers: [], prompts: [], actions: [action], ignored: [] },
      config: [],
      configured: [],
      problems: [],
      origin: "other",
      sourceKind: "github",
    };
    bridge.runtime.dispatch = async (request: unknown) => {
      dispatched.push(request);
      const { type } = (request as { command: { type: string } }).command;
      const result =
        type === "plugins.contributions"
          ? { prompts: [], actions: [action] }
          : type === "plugins.list"
            ? { plugins: [kit], pluginsPath: "/data/plugins" }
            : undefined;
      return {
        commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
        accepted: true as const,
        ...(result ? { result } : {}),
      };
    };
    const container = await render(bridge);
    const runFromPalette = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(".command-trigger")?.click();
      });
      await act(async () => {
        button(container, "Test (kit)")?.click();
      });
    };
    const terminals = () => commands(dispatched).filter((command) => command.type === "terminal.create");

    await runFromPalette();
    const dialog = container.querySelector('[role="dialog"][aria-label="Run plugin action"]');
    expect(dialog?.querySelector(".dialog-title")?.textContent).toBe("Run Test from Kit?");
    expect(dialog?.querySelector("pre code")?.textContent).toBe("npm test");
    expect(dialog?.textContent).toContain("Unknown source");
    expect(terminals()).toHaveLength(0);
    await act(async () => {
      button(container, "Run")?.click();
    });
    expect(container.querySelector('[aria-label="Run plugin action"]')).toBeNull();
    expect(terminals()).toEqual([expect.objectContaining({ args: ["-lc", "npm test"], worktreeId })]);

    await runFromPalette();
    expect(container.querySelector('[aria-label="Run plugin action"]')).toBeNull();
    expect(terminals()).toHaveLength(2);
  });
});

describe("Settings", () => {
  const setValue = async (element: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const picker = (scope: HTMLElement, label: string) => {
    const trigger = scope.querySelector<HTMLButtonElement>(`button[aria-haspopup="listbox"][aria-label^="${label}: "]`);
    if (!trigger) throw new Error(`The ${label} picker is missing.`);
    return trigger;
  };
  const choose = async (scope: HTMLElement, label: string, option: string) => {
    const trigger = picker(scope, label);
    await act(async () => trigger.click());
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (entry) => entry.dataset.label === option,
    );
    if (!choice) throw new Error(`${label} has no ${option} option.`);
    await act(async () => choice.click());
    return trigger;
  };
  const press = async (target: EventTarget, init: KeyboardEventInit) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  };
  const dialog = (name: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);
  const openSettings = async (container: HTMLElement, tab?: string) => {
    await act(async () => {
      button(container, "Settings")?.click();
    });
    const settings = dialog("Settings");
    if (!settings) throw new Error("Settings did not open.");
    if (tab) {
      await act(async () => {
        [...settings.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((entry) => entry.textContent === tab)
          ?.click();
      });
    }
    return settings;
  };

  afterEach(() => {
    updateAppSettings(() => structuredClone(DEFAULT_SETTINGS));
  });

  it("rebinds a shortcut, refuses one that is taken, and runs the new keys", async () => {
    const container = await render(makeBridge(discovered));
    const settings = await openSettings(container, "Shortcuts");
    const newAgent = button(settings, "New agent, Ctrl+N. Change shortcut");
    if (!newAgent) throw new Error("The New agent shortcut is missing.");
    await act(async () => {
      newAgent.click();
    });
    await press(newAgent, { key: "k", code: "KeyK", ctrlKey: true });
    expect(settings.querySelector('[role="alert"]')?.textContent).toBe("Ctrl+K: Already used by Command palette.");
    expect(dialog("Settings")).not.toBeNull();
    await press(newAgent, { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });
    expect(settings.querySelector('[role="alert"]')).toBeNull();
    expect(button(settings, "New agent, Ctrl+Shift+N. Change shortcut")).not.toBeUndefined();
    expect(container.querySelector(".sidebar-new-agent")?.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+N");

    await press(window, { key: "Escape", code: "Escape" });
    expect(dialog("Settings")).toBeNull();
    await press(window, { key: "n", code: "KeyN", ctrlKey: true });
    expect(dialog("New agent")).toBeNull();
    await press(window, { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });
    expect(dialog("New agent")).not.toBeNull();
  });

  it("starts New agent with the saved defaults and branch template", async () => {
    const container = await render(makeBridge(discovered));
    const agents = await openSettings(container);
    expect((await choose(agents, "View", "Chat")).getAttribute("aria-label")).toBe("View: Chat");
    await act(async () => {
      [...agents.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((entry) => entry.textContent === "Worktrees")
        ?.click();
    });
    const template = agents.querySelector<HTMLInputElement>('input[aria-label="Branch name template"]');
    if (!template) throw new Error("The branch template field is missing.");
    await setValue(template, "zli/{agent}-{random}");
    expect(agents.textContent).toContain("zli/claude-k3f9");

    await press(window, { key: "Escape", code: "Escape" });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".sidebar-new-agent")?.click();
    });
    const newAgent = dialog("New agent");
    const chat = [...(newAgent?.querySelectorAll<HTMLInputElement>('input[name="agent-mode"]') ?? [])].find(
      (input) => input.closest("label")?.textContent === "Chat",
    );
    expect(chat?.checked).toBe(true);
    await act(async () => {
      [...(newAgent?.querySelectorAll<HTMLInputElement>('input[name="agent-placement"]') ?? [])]
        .find((input) => input.closest("label")?.textContent === "New worktree")
        ?.click();
    });
    expect(newAgent?.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')?.value).toMatch(
      /^zli\/claude-[a-z0-9]{4}$/u,
    );
  });

  it("picks permissions in the New agent dialog, and Escape closes only the open list", async () => {
    const container = await render(makeBridge(discovered));
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".sidebar-new-agent")?.click();
    });
    const trigger = dialog("New agent")?.querySelector<HTMLButtonElement>('button[aria-label^="Permissions"]');
    await act(async () => trigger?.click());
    const list = () => document.querySelector('[role="listbox"][aria-label="Permissions"]');
    expect(list()).not.toBeNull();
    await press(document.activeElement ?? window, { key: "Escape", code: "Escape" });
    expect(list()).toBeNull();
    expect(dialog("New agent")).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger?.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((option) => option.textContent?.startsWith("Read only"))
        ?.click(),
    );
    expect(trigger?.getAttribute("aria-label")).toBe("Permissions: Read only");
    expect(dialog("New agent")?.textContent).toContain("Reads and plans, never changes files");
  });

  it("lets a project override the agent defaults", async () => {
    updateAppSettings((current) => ({ ...current, defaults: { permissionMode: "full-access" } }));
    const container = await render(makeBridge(discovered));
    const settings = await openSettings(container, "Projects");
    expect(picker(settings, "Permissions").getAttribute("aria-label")).toBe("Permissions: Same as New agents");
    await choose(settings, "Permissions", "Auto");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(button(settings, "Reset repo to New agents")).not.toBeUndefined();

    await press(window, { key: "Escape", code: "Escape" });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".sidebar-new-agent")?.click();
    });
    const permissionPicker = dialog("New agent")?.querySelector(
      'button[aria-haspopup="listbox"][aria-label^="Permissions"]',
    );
    expect(permissionPicker?.getAttribute("aria-label")).toBe("Permissions: Auto");
  });
});

describe("Updates", () => {
  const ready: UpdateStatus = {
    state: { status: "ready", version: "0.2.0", notes: "Faster startup" },
    currentVersion: "0.1.0",
    autoInstall: true,
    channel: "stable",
  };
  const working: RuntimeProjection = {
    ...withAgent,
    threads: [
      {
        threadId: "00000000-0000-4000-8000-000000000401",
        worktreeId,
        provider: "claude-code",
        status: "working",
        capabilities: {},
        sessionId: agentSessionId,
      } as RuntimeProjection["threads"][number],
    ],
  };
  const withUpdates = (base: ZliBridge, status: UpdateStatus, whatsNew?: WhatsNew) => {
    const calls: string[] = [];
    let listener: ((next: UpdateStatus) => void) | undefined;
    const bridge: ZliBridge = {
      ...base,
      updates: {
        getStatus: async () => status,
        onStatus: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        check: async () => {
          calls.push("check");
          return status;
        },
        download: async () => {
          calls.push("download");
          return status;
        },
        quitAndInstall: async () => {
          calls.push("install");
          return true;
        },
        openReleasePage: async () => {
          calls.push("open-release");
        },
        setAutoInstall: async (autoInstall) => {
          calls.push(`auto-install:${autoInstall}`);
          return { ...status, autoInstall };
        },
        whatsNew: async () => whatsNew,
        dismissWhatsNew: async () => {
          calls.push("dismiss-whats-new");
        },
      },
    };
    return { bridge, calls, push: (next: UpdateStatus) => listener?.(next) };
  };
  const dialog = (name: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);

  it("restarts into a downloaded update from the title bar, asking first while an agent works", async () => {
    const { bridge, calls } = withUpdates(makeBridge(working), ready);
    const container = await render(bridge);
    const pill = button(container, "Restart to update to v0.2.0");
    expect(pill).not.toBeUndefined();

    await act(async () => {
      pill?.click();
    });
    const confirm = dialog("Restart to update");
    expect(confirm?.textContent).toContain("An agent is still working");
    expect(calls).toEqual([]);
    await act(async () => {
      [...(confirm?.querySelectorAll("button") ?? [])].find((entry) => entry.textContent === "Restart anyway")?.click();
    });
    expect(calls).toEqual(["install"]);
    expect(dialog("Restart to update")).toBeNull();
  });

  it("restarts at once when no agent is mid-turn", async () => {
    const { bridge, calls } = withUpdates(makeBridge(withAgent), ready);
    const container = await render(bridge);
    await act(async () => {
      button(container, "Restart to update to v0.2.0")?.click();
    });
    expect(dialog("Restart to update")).toBeNull();
    expect(calls).toEqual(["install"]);
  });

  it("links unsigned macOS builds to the release page and follows pushed status", async () => {
    const idle: UpdateStatus = { ...ready, state: { status: "idle" } };
    const { bridge, calls, push } = withUpdates(makeBridge(projection), idle);
    const container = await render(bridge);
    expect(container.querySelector(".update-pill")).toBeNull();

    await act(async () => {
      push({
        ...idle,
        state: {
          status: "available",
          version: "0.3.0",
          releaseUrl: "https://github.com/RosMengHeang/ZLI/releases/tag/v0.3.0",
          canAutoInstall: false,
        },
      });
    });
    await act(async () => {
      button(container, "Update available: v0.3.0")?.click();
    });
    expect(calls).toEqual(["open-release"]);
  });

  it("shows the version, status, channel, and automatic install switch in Settings", async () => {
    const status: UpdateStatus = { ...ready, state: { status: "idle" }, lastCheckedAt: "2025-01-02T03:04:05.000Z" };
    const { bridge, calls } = withUpdates(makeBridge(projection), status);
    const container = await render(bridge);
    await act(async () => {
      button(container, "Settings")?.click();
    });
    const settings = dialog("Settings");
    await act(async () => {
      [...(settings?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
        .find((entry) => entry.textContent === "Updates")
        ?.click();
    });
    expect(settings?.textContent).toContain("0.1.0");
    expect(settings?.textContent).toContain("ZLI is up to date.");
    expect(settings?.textContent).toContain("Last checked");
    const channel = settings?.querySelector<HTMLButtonElement>('button[aria-label^="Update channel"]');
    expect(channel?.getAttribute("aria-disabled")).toBe("true");
    expect(channel?.getAttribute("aria-label")).toBe("Update channel: Stable");
    await act(async () => channel?.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      button(settings ?? container, "Check for updates")?.click();
    });
    const toggle = settings?.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(toggle?.checked).toBe(true);
    await act(async () => {
      toggle?.click();
    });
    expect(calls).toEqual(["check", "auto-install:false"]);
    expect(toggle?.checked).toBe(false);
  });

  it("shows What's new once and records it when closed", async () => {
    const { bridge, calls } = withUpdates(
      makeBridge(projection),
      { ...ready, state: { status: "idle" } },
      {
        version: "0.1.0",
        notes: "## Fixes\n\n- Faster startup",
        releaseUrl: "https://github.com/RosMengHeang/ZLI/releases/tag/v0.1.0",
      },
    );
    await render(bridge);
    // The dialog loads lazily, so wait for its module.
    for (let attempt = 0; attempt < 100 && !dialog("What's new"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const whatsNew = dialog("What's new");
    expect(whatsNew?.textContent).toContain("What's new in v0.1.0");
    expect(whatsNew?.querySelector("li")?.textContent).toBe("Faster startup");
    await act(async () => {
      [...(whatsNew?.querySelectorAll("button") ?? [])].find((entry) => entry.textContent === "Done")?.click();
    });
    expect(dialog("What's new")).toBeNull();
    expect(calls).toEqual(["dismiss-whats-new"]);
  });
});
