// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZliBridge } from "./runtime/bridge.js";
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

function firstBrowserTab() {
  const browserTab = projection.browserTabs[0];
  if (!browserTab) throw new Error("The test projection has no browser tab.");
  return browserTab;
}

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
    const codex = dialog?.querySelector<HTMLInputElement>('input[value="codex"]');
    const claude = dialog?.querySelector<HTMLInputElement>('input[value="claude-code"]');
    expect(codex?.disabled).toBe(true);
    expect(claude?.checked).toBe(true);
    expect(dialog?.textContent).not.toContain("OpenCode");
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
    const sessionId = "00000000-0000-4000-8000-000000000201";
    const withAgent: RuntimeProjection = {
      ...discovered,
      terminals: [
        {
          terminalId: "00000000-0000-4000-8000-000000000301",
          worktreeId,
          title: "Claude Code",
          status: "running",
          kind: "agent",
          agent: { provider: "claude-code", permissionMode: "full-access" },
          sessionId,
        } as RuntimeProjection["terminals"][number],
      ],
    };
    const container = await render(makeBridge(withAgent));
    expect(container.querySelectorAll(".agent-tile")).toHaveLength(1);
    expect(container.querySelector('[aria-label="Claude Code terminal"]')).not.toBeNull();
    expect(container.querySelector(".session-row")?.getAttribute("aria-label")).toBe("Claude Code, Claude Code, Ready");
    await act(async () => {
      button(container, "Close tile")?.click();
    });
    expect(container.querySelectorAll(".agent-tile")).toHaveLength(0);
    expect(container.textContent).toContain("Pick an agent in the sidebar");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".session-row")?.click();
    });
    expect(container.querySelectorAll(".agent-tile")).toHaveLength(1);
  });
});
