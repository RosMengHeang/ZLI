// @vitest-environment jsdom

import type { MobilePackageCheck, MobileProposal } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MobileBridge } from "../../../runtime/bridge.js";
import type { MobileDevContext } from "../context.js";
import { PackagesGroup, parsePackages } from "./PackagesGroup.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const result: MobilePackageCheck = {
  verdicts: [
    { name: "react-native-reanimated", verdict: "ok", reasons: ["Supports the New Architecture."] },
    {
      name: "react-native-fs",
      verdict: "warn",
      reasons: ["React Native Directory marks it unmaintained. Look for a maintained alternative."],
    },
  ],
  install: {
    kind: "command",
    program: "npx",
    args: ["expo", "install", "react-native-reanimated", "react-native-fs"],
    cwd: ".",
  },
  command: "npx expo install react-native-reanimated react-native-fs",
};

function setup(answer: MobilePackageCheck = result) {
  const packages = {
    check: vi.fn(async () => answer),
    proposeInstall: vi.fn(async () => ({}) as MobileProposal),
  };
  const context: MobileDevContext = {
    mobile: { dev: { packages } } as unknown as MobileBridge,
    worktreeId: "wt-1",
    device: undefined,
    online: false,
    agentHolds: false,
    devServers: [],
    onError: vi.fn(),
    onNotice: vi.fn(),
  };
  return { packages, context };
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
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function type(container: HTMLElement, text: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
}

describe("the Packages group", () => {
  it("splits names and refuses what is not a package name", () => {
    expect(parsePackages("react-native-mmkv, expo-camera  expo-camera")).toEqual({
      names: ["react-native-mmkv", "expo-camera"],
    });
    expect(parsePackages("@shopify/flash-list@2.0.0")).toEqual({ names: ["@shopify/flash-list@2.0.0"] });
    expect(parsePackages("ok $(rm -rf)")).toEqual({ problem: "$(rm is not an npm package name." });
    expect(parsePackages(Array.from({ length: 21 }, (_, index) => `p${index}`).join(" "))).toEqual({
      problem: "Check at most 20 packages at a time.",
    });
  });

  it("disables Check for a bad name and says why", async () => {
    const { context, packages } = setup();
    const container = await render(<PackagesGroup context={context} />);
    expect(button(container, "Check").disabled).toBe(true);
    await type(container, "Bad Name");
    expect(container.textContent).toContain("Bad is not an npm package name.");
    expect(button(container, "Check").disabled).toBe(true);
    await submit(container);
    expect(packages.check).not.toHaveBeenCalled();
  });

  it("shows each verdict and the install line, then proposes it without running it", async () => {
    const { context, packages } = setup();
    const container = await render(<PackagesGroup context={context} />);
    await type(container, "react-native-reanimated react-native-fs");
    await submit(container);
    expect(packages.check).toHaveBeenCalledWith("wt-1", ["react-native-reanimated", "react-native-fs"]);
    const rows = container.querySelectorAll('[aria-label="Package results"] li');
    expect([...rows].map((row) => row.textContent)).toEqual([
      "Finereact-native-reanimatedSupports the New Architecture.",
      "Warningreact-native-fsReact Native Directory marks it unmaintained. Look for a maintained alternative.",
    ]);
    expect(container.querySelector("pre")?.textContent).toBe(
      "npx expo install react-native-reanimated react-native-fs",
    );
    await act(async () => button(container, "Propose install").click());
    expect(packages.proposeInstall).toHaveBeenCalledWith("wt-1", ["react-native-reanimated", "react-native-fs"]);
    expect(context.onNotice).toHaveBeenCalledWith(expect.stringContaining("Nothing runs until you choose Run"));
  });

  it("keeps Propose install off when every package was blocked", async () => {
    const { context } = setup({
      verdicts: [
        { name: "react-native-fs", verdict: "block", reasons: ["It is not tested with the New Architecture."] },
      ],
    });
    const container = await render(<PackagesGroup context={context} />);
    await type(container, "react-native-fs");
    await submit(container);
    expect(button(container, "Propose install").disabled).toBe(true);
  });

  it("shows a failed check as an error", async () => {
    const { context, packages } = setup();
    packages.check.mockRejectedValue(new Error("That worktree is not in ZLI."));
    const container = await render(<PackagesGroup context={context} />);
    await type(container, "react-native-fs");
    await submit(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("That worktree is not in ZLI.");
  });

  it("drops a check that answers after the worktree changed", async () => {
    let answer: (value: MobilePackageCheck) => void = () => {};
    const { context, packages } = setup();
    packages.check.mockImplementation(
      () =>
        new Promise<MobilePackageCheck>((resolve) => {
          answer = resolve;
        }),
    );
    const container = await render(<PackagesGroup context={context} />);
    await type(container, "react-native-fs");
    await submit(container);
    await act(async () => root?.render(<PackagesGroup context={{ ...context, worktreeId: "wt-2" }} />));
    await act(async () => answer(result));
    expect(container.querySelector('[aria-label="Package results"]')).toBeNull();
    expect(container.querySelector("input")?.value).toBe("");
  });
});
