// @vitest-environment jsdom

import type { HistoryFolder, ProjectProjection, ProviderDiscovery, RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buttonByText, cleanupRuntimeRenders, renderWithRuntime } from "../review/testRuntime.js";
import { readAppSettings, updateAppSettings } from "../settings/appSettings.js";
import { WelcomeDialog } from "./WelcomeDialog.js";
import type { Dispatch } from "./welcomeClient.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
  updateAppSettings(({ onboardedAt: _, ...rest }) => rest);
});

const claude = {
  provider: "claude-code",
  displayName: "Claude Code",
  status: "found",
  path: "/bin/claude",
} as ProviderDiscovery;

const folder = (name: string): HistoryFolder => ({
  path: `/work/${name}`,
  name,
  lastActiveAt: "2026-11-15T09:00:00.000Z",
  sources: ["claude-code"],
});

const project = (name: string): ProjectProjection =>
  ({ projectId: `project-${name}`, path: `/work/${name}`, name }) as ProjectProjection;

type Register = (path: string) => Promise<{ project: ProjectProjection; existing: boolean } | { error: string }>;

async function renderWelcome({
  folders = [],
  register = async (path) => ({ project: project(path.split("/").at(-1) ?? path), existing: false }),
  pickFolder,
}: {
  folders?: HistoryFolder[];
  register?: Register;
  pickFolder?: () => Promise<string | undefined>;
} = {}) {
  const dispatch: Dispatch = async (request) => {
    const { command } = request as { command: { type: string } };
    return (
      command.type === "history.scan"
        ? { commandId: "c", accepted: true, result: { folders } }
        : { commandId: "c", accepted: false, error: { code: "invalid_request", message: "No", retryable: false } }
    ) as Awaited<ReturnType<Dispatch>>;
  };
  const onDone = vi.fn();
  const onStart = vi.fn(async () => undefined);
  const registerProjectPath = vi.fn(register);
  await renderWithRuntime(
    <WelcomeDialog
      projection={{ providers: [claude] } as unknown as RuntimeProjection}
      dispatch={dispatch}
      pickFolder={pickFolder}
      registerProjectPath={registerProjectPath}
      onStart={onStart}
      onDone={onDone}
    />,
    () => ({ result: {} }),
  );
  return { onDone, onStart, registerProjectPath };
}

async function click(element: Element | undefined) {
  if (!element) throw new Error("Nothing to click");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function toProjects() {
  await click(buttonByText("Continue"));
  await click(buttonByText("Continue"));
}

const tick = (name: string) =>
  [...document.querySelectorAll("label")].find((label) => label.textContent?.includes(name))?.querySelector("input") ??
  undefined;

const alertText = () => document.querySelector('[role="alert"]')?.textContent;

describe("WelcomeDialog", () => {
  it("skips setup and records it", async () => {
    const { onDone } = await renderWelcome();
    await click(buttonByText("Skip setup"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(readAppSettings().onboardedAt).toBeTruthy();
  });

  it("finishes with no folders without adding a project or starting an agent", async () => {
    const { onDone, onStart, registerProjectPath } = await renderWelcome();
    await toProjects();
    await click(buttonByText("Open ZLI"));
    expect(registerProjectPath).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while projects are being added", async () => {
    let release: (() => void) | undefined;
    const { onDone, onStart } = await renderWelcome({
      folders: [folder("web")],
      register: (path) =>
        new Promise((resolve) => {
          release = () => resolve({ project: project(path.split("/").at(-1) ?? path), existing: false });
        }),
    });
    await toProjects();
    await click(tick("web"));
    await click(buttonByText("Add 1 project and open"));

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      release?.();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("lists a folder picked twice only once", async () => {
    await renderWelcome({ pickFolder: async () => "/work/new" });
    await toProjects();
    await click(buttonByText("Add a folderAny repository on this computer"));
    await click(buttonByText("Add a folderAny repository on this computer"));
    expect(document.querySelectorAll('button[aria-label="Remove new"]')).toHaveLength(1);
    expect(buttonByText("Add 1 project and open")).toBeDefined();
  });

  it("names the folders that failed and does not add the others again on retry", async () => {
    const failing = new Set(["/work/beta"]);
    const { onDone, registerProjectPath } = await renderWelcome({
      folders: [folder("alpha"), folder("beta")],
      register: async (path) =>
        failing.has(path)
          ? { error: "Folder is gone" }
          : { project: project(path.split("/").at(-1) ?? path), existing: false },
    });
    await toProjects();
    await click(buttonByText("Select all"));
    await click(buttonByText("Add 2 projects and open"));
    expect(alertText()).toBe("Could not add beta. Try again, or untick it.");
    expect(onDone).not.toHaveBeenCalled();

    failing.clear();
    registerProjectPath.mockClear();
    await click(buttonByText("Add 2 projects and open"));
    expect(registerProjectPath.mock.calls.map(([path]) => path)).toEqual(["/work/beta"]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
