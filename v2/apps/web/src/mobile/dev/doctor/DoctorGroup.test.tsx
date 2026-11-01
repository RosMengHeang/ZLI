// @vitest-environment jsdom

import type { MobileProjectFacts, MobileProposal } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MobileBridge } from "../../../runtime/bridge.js";
import type { MobileDevContext } from "../context.js";
import { DoctorGroup, signingText } from "./DoctorGroup.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const facts: MobileProjectFacts = {
  worktreeId: "wt-1",
  appDir: "apps/mobile",
  stack: "expo",
  versions: { expo: "55.0.4", "react-native": "0.83.1" },
  host: { node: "24.22.1", java: "not found", xcode: "not checked" },
  client: { kind: "expo-go", reason: "expo-dev-client is not installed." },
  newArch: { enabled: true, source: "Expo SDK 55 always uses it", disabledIn: ["app.json"] },
  signing: { android: "debug-only", ios: "not-checked" },
  findings: [
    {
      id: "newarch-optout-removed",
      severity: "error",
      title: "Expo SDK 55 cannot turn off the New Architecture",
      detail: "Remove newArchEnabled: false from app.json.",
    },
    {
      id: "expo-go-sdk55",
      severity: "warning",
      title: "Expo Go stops at SDK 54",
      detail: "Use a development build.",
      fix: { kind: "command", program: "npx", args: ["expo", "install", "expo-dev-client"], cwd: "apps/mobile" },
    },
  ],
  notes: { file: "AGENTS.md", state: "missing" },
  fingerprint: "abc",
  checkedAt: "2026-01-02T03:04:05.000Z",
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function setup(overrides: Partial<MobileProjectFacts> = {}, before: MobileProposal[] = []) {
  const listeners = new Set<(list: MobileProposal[]) => void>();
  const doctor = {
    check: vi.fn(async () => ({ ...facts, ...overrides })),
    deepPlan: vi.fn(async () => ({
      folder: "apps/mobile",
      commands: ["npx expo config --json", "npx expo install --check", "npx expo-doctor"],
    })),
    deepRun: vi.fn(async () => ({
      ranAt: "2026-01-02T03:04:05.000Z",
      expoConfig: { state: "passed" as const },
      expoInstallCheck: { state: "failed" as const, packages: ["react-native@0.83.2"], detail: "" },
    })),
    proposeBlock: vi.fn(async () => ({ upToDate: false as const, file: "AGENTS.md", proposalId: "p-1" })),
    proposeFix: vi.fn(async () => ({}) as MobileProposal),
  };
  const proposals = {
    list: vi.fn(async () => before),
    onChange: (listener: (list: MobileProposal[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const context: MobileDevContext = {
    mobile: { dev: { doctor, proposals } } as unknown as MobileBridge,
    worktreeId: "wt-1",
    device: undefined,
    online: false,
    agentHolds: false,
    devServers: [],
    onError: vi.fn(),
    onNotice: vi.fn(),
  };
  const publish = (list: MobileProposal[]) => {
    for (const listener of listeners) listener(list);
  };
  return { doctor, context, publish };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("the Toolchain group", () => {
  it("shows versions, this computer's tools, and the problems ZLI found", async () => {
    const { context, doctor } = setup();
    const container = await render(<DoctorGroup context={context} />);
    expect(doctor.check).toHaveBeenCalledWith("wt-1", {});
    const versions = container.querySelector('[aria-label="Versions"]')?.textContent ?? "";
    expect(versions).toContain("App folderapps/mobile");
    expect(versions).toContain("Expo SDK55.0.4");
    expect(versions).toContain("Node.js24.22.1");
    expect(versions).toContain("JavaNot found");
    expect(versions).toContain("XcodeNot checked on this computer");
    expect(versions).toContain("Runs inexpo-dev-client is not installed.Expo Go");
    const problems = container.querySelector('[aria-label="Problems"]');
    expect(problems?.querySelectorAll("li")).toHaveLength(2);
    expect(problems?.textContent).toContain("ErrorExpo SDK 55 cannot turn off the New Architecture");
    expect(button(container, "Propose fix: Expo Go stops at SDK 54").textContent).toBe("Propose fix");
  });

  it("proposes a fix without running it and says where the card is", async () => {
    const { context, doctor } = setup();
    const container = await render(<DoctorGroup context={context} />);
    await click(button(container, "Propose fix: Expo Go stops at SDK 54"));
    expect(doctor.proposeFix).toHaveBeenCalledWith("wt-1", "expo-go-sdk55");
    expect(context.onNotice).toHaveBeenCalledWith(expect.stringContaining("Nothing runs until you choose Run"));
  });

  it("shows the Expo check lines before running them, and runs only after Run", async () => {
    const { context, doctor } = setup();
    const container = await render(<DoctorGroup context={context} />);
    await click(button(container, "Run Expo checks"));
    expect(doctor.deepRun).not.toHaveBeenCalled();
    expect(container.querySelector(".mobile-doctor-plan pre")?.textContent).toBe(
      "npx expo config --json\nnpx expo install --check\nnpx expo-doctor",
    );
    expect(container.textContent).toContain("Runs in apps/mobile.");
    await click(button(container, "Run"));
    expect(doctor.deepRun).toHaveBeenCalledWith("wt-1");
    const results = container.querySelector('[aria-label="Expo check results"]')?.textContent ?? "";
    expect(results).toContain("expo configPassed");
    expect(results).toContain("expo install --checkFailedreact-native@0.83.2");
  });

  it("prepares the notes, then shows Up to date once they are written", async () => {
    const { context, doctor, publish } = setup();
    const container = await render(<DoctorGroup context={context} />);
    await click(button(container, "Prepare notes"));
    expect(doctor.proposeBlock).toHaveBeenCalledWith("wt-1");
    expect(context.onNotice).toHaveBeenCalledWith(expect.stringContaining("Nothing is written until you choose Write"));
    doctor.check.mockResolvedValue({ ...facts, notes: { file: "AGENTS.md", state: "current" } });
    await act(async () =>
      publish([{ proposalId: "p-1", worktreeId: "wt-1", state: "written" } as unknown as MobileProposal]),
    );
    expect(doctor.check).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Up to date");
  });

  it("says when there is no app, and shows a failed check as an error", async () => {
    const none = setup({ stack: "none" });
    const container = await render(<DoctorGroup context={none.context} />);
    expect(container.textContent).toContain("No mobile app found in this worktree.");
    act(() => root?.unmount());
    const failing = setup();
    failing.doctor.check.mockRejectedValue(new Error("That worktree is not in ZLI."));
    const failed = await render(<DoctorGroup context={failing.context} />);
    expect(failed.querySelector('[role="alert"]')?.textContent).toBe("That worktree is not in ZLI.");
  });

  it("describes signing in plain words", () => {
    expect(signingText({ android: "release-config", ios: { identities: 1 } })).toBe(
      "Android: a release signing config in the Gradle build. iPhone: 1 signing identity.",
    );
  });

  it("ignores cards acted on before the group opened, and re-checks when the person starts a fix", async () => {
    const old = { proposalId: "p-old", worktreeId: "wt-1", state: "written" } as MobileProposal;
    const { context, doctor, publish } = setup({}, [old]);
    await render(<DoctorGroup context={context} />);
    expect(doctor.check).toHaveBeenCalledTimes(1);
    await act(async () => publish([old]));
    expect(doctor.check).toHaveBeenCalledTimes(1);
    const fix = { proposalId: "p-new", worktreeId: "wt-1", state: "started" } as MobileProposal;
    await act(async () => publish([old, fix]));
    expect(doctor.check).toHaveBeenCalledTimes(2);
  });

  it("explains markers it cannot update", async () => {
    const { context } = setup({ notes: { file: "AGENTS.md", state: "unbalanced" } });
    const container = await render(<DoctorGroup context={context} />);
    expect(container.textContent).toContain("markers ZLI cannot update");
  });
});
