// @vitest-environment jsdom
import type { ProviderUpdateInfo, UpdateStatus } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { type AgentUpdatesState, resetAgentUpdates } from "./agentUpdatesStore.js";
import { agentDetail, agentRows, appUpdateLine, SidebarUpdateCard } from "./SidebarUpdateCard.js";

const codex: ProviderUpdateInfo = {
  provider: "codex",
  displayName: "Codex",
  current: "0.169.0",
  latest: "0.171.0",
  status: "behind",
  method: "npm",
  canUpdate: true,
  command: "npm install -g @openai/codex@latest",
};

const status = (state: UpdateStatus["state"]): UpdateStatus => ({
  state,
  currentVersion: "44.10.0",
  autoInstall: true,
  channel: "stable",
});

const handlers = { onRestart: vi.fn(), onOpenRelease: vi.fn(), onDownload: vi.fn() };

async function mount(updates: ProviderUpdateInfo[], app?: UpdateStatus) {
  resetAgentUpdates();
  const commands: string[] = [];
  const dispatch = vi.fn(async (request: { commandId: string; command: { type: string } }) => {
    commands.push(request.command.type);
    return { commandId: request.commandId, accepted: true, result: { updates } };
  });
  const bridge = {
    runtime: { getProjection: async () => undefined, onProjection: () => () => undefined, dispatch },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <SidebarUpdateCard status={app} connected {...handlers} onOpenSettings={() => undefined} />
      </RuntimeProvider>,
    );
  });
  return { container, commands, root };
}

describe("appUpdateLine", () => {
  it("asks for a restart once the update is downloaded", () => {
    const line = appUpdateLine(status({ status: "ready", version: "44.11.0" }), handlers);
    expect(line).toMatchObject({ title: "ZLI 44.11.0", action: { label: "Restart" } });
    line?.action?.run();
    expect(handlers.onRestart).toHaveBeenCalled();
  });

  it("shows download progress and stays quiet with nothing new", () => {
    expect(appUpdateLine(status({ status: "downloading", version: "44.11.0", percent: 42.4 }), handlers)).toMatchObject(
      {
        detail: "Downloading, 42%",
        percent: 42.4,
      },
    );
    expect(appUpdateLine(status({ status: "idle" }), handlers)).toBeUndefined();
  });
});

describe("SidebarUpdateCard", () => {
  afterEach(() => window.localStorage.clear());

  it("shows nothing while everything is up to date", async () => {
    const { container, root } = await mount([{ ...codex, status: "current", current: "0.171.0" }]);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
  });

  it("lists the app and an agent with a new version, and hides until the next one once closed", async () => {
    const { container, commands, root } = await mount([codex], status({ status: "ready", version: "44.11.0" }));
    expect(commands).toEqual(["providers.checkUpdates"]);
    expect(container.textContent).toContain("ZLI 44.11.0");
    expect(container.textContent).toContain("0.169.0 → 0.171.0");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Hide until the next update"]')?.click(),
    );
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());

    const again = await mount([{ ...codex, latest: "0.172.0" }], status({ status: "ready", version: "44.11.0" }));
    expect(again.container.textContent).toContain("0.169.0 → 0.172.0");
    act(() => again.root.unmount());
  });

  it("offers Update all once two or more agents are waiting", async () => {
    const opencode = { ...codex, provider: "opencode" as const, displayName: "OpenCode" };
    const one = await mount([codex]);
    expect(one.container.textContent).not.toContain("Update all");
    act(() => one.root.unmount());

    const two = await mount([codex, opencode]);
    const all = [...two.container.querySelectorAll("button")].find((b) => b.textContent === "Update all");
    expect(all).toBeDefined();
    await act(async () => all?.click());
    expect(two.commands.filter((type) => type === "providers.update")).toHaveLength(2);
    act(() => two.root.unmount());
  });
});

describe("agent rows", () => {
  const base: AgentUpdatesState = {
    updates: [codex],
    checking: false,
    checkedAt: 0,
    error: undefined,
    running: new Set(),
    notes: {},
  };

  it("shows where an agent goes from and to while it waits", () => {
    const rows = agentRows(base, 0);
    expect(rows.map((row) => row.state)).toEqual(["pending"]);
    expect(rows[0] && agentDetail(rows[0])).toBe("0.169.0 → 0.171.0");
  });

  it("confirms a finished update for a few seconds, then lets it go", () => {
    const done: AgentUpdatesState = {
      ...base,
      updates: [{ ...codex, status: "current", current: "0.171.0" }],
      notes: { codex: { tone: "ok", text: "Codex is now on 0.171.0.", version: "0.171.0", at: 1_000 } },
    };
    const rows = agentRows(done, 2_000);
    expect(rows[0] && agentDetail(rows[0])).toBe("Now on 0.171.0. New chats use it.");
    expect(agentRows(done, 10_000)).toEqual([]);
  });

  it("offers a retry when an update failed", () => {
    const failed = { ...base, notes: { codex: { tone: "error" as const, text: "EACCES", at: 0 } } };
    expect(agentRows(failed, 0).map((row) => row.state)).toEqual(["failed"]);
  });
});
