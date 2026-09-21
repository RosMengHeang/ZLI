// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { CommandId, EnvironmentId, ProjectId, WorktreeId, type RuntimeProjection } from "@zli-v2/contracts";
import { AppShell } from "./shell/AppShell.js";
import type { ZliBridge } from "./runtime/bridge.js";

const projection: RuntimeProjection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: { worktrees: true, terminals: true, browser: true, eventReplay: true },
  },
  projects: [{ projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"), path: "C:/repo", name: "repo" }],
  worktrees: [{ worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000011"), projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"), path: "C:/repo", branch: "main", status: "ready" }],
  threads: [], terminals: [], browserTabs: [], attention: [], lastSequence: 1,
};

const bridge: ZliBridge = {
  runtime: { dispatch: async () => ({ commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true as const }), getProjection: async () => projection, onProjection: () => () => undefined },
  browser: {
    create: async () => projection.browserTabs[0]!, close: async () => undefined, activate: async () => projection.browserTabs[0]!, navigate: async () => projection.browserTabs[0]!, setBounds: async () => undefined, back: async () => undefined, forward: async () => undefined, reload: async () => undefined, stop: async () => undefined, snapshot: async () => undefined, click: async () => undefined, fill: async () => undefined, press: async () => undefined, waitForNetworkIdle: async () => ({ idle: true }), screenshot: async () => undefined, inspectElement: async () => undefined, designInspect: async () => undefined, consoleEntries: async () => [], networkEntries: async () => [],
  },
  dialog: { openProject: async () => undefined }, menu: { trigger: async () => undefined }, app: { getVersion: async () => "0.0.0", quit: async () => undefined },
};

afterEach(() => document.body.replaceChildren());

describe("AppShell", () => {
  it("renders real project/worktree context and the honest empty terminal state", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => { createRoot(container).render(<AppShell bridge={bridge} />); });
    expect(container.textContent).toContain("repo");
    expect(container.textContent).toContain("main");
    expect(container.textContent).toContain("No terminal session");
    expect(container.textContent).not.toContain("12,483");
  });

  it("provides a keyboard-accessible command palette with working pane actions", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => { createRoot(container).render(<AppShell bridge={bridge} />); });
    const trigger = container.querySelector<HTMLButtonElement>(".command-trigger");
    expect(trigger).not.toBeNull();
    await act(async () => { trigger?.click(); });
    expect(container.textContent).toContain("Focus browser");
    const browserAction = [...container.querySelectorAll("button")].find((button) => button.textContent === "Focus browser");
    expect(browserAction).not.toBeUndefined();
    await act(async () => { browserAction?.click(); });
    expect(container.textContent).toContain("A browser that belongs to this worktree");
  });
});
