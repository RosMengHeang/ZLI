import type { MobileDevice, RuntimeProjection } from "@zli-v2/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

import type { MobileBridge, ZliBridge } from "../../../runtime/bridge.js";
import { RuntimeProvider } from "../../../runtime/RuntimeProvider.js";
import type { MobileDevContext } from "../context.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const pixel = { deviceId: "android-avd:Pixel_7", name: "Pixel 7", state: "online" } as MobileDevice;

/** A runtime with one worktree, wt-1 on branch feat-login, and an idle chat agent in it unless `agent` is false. */
export function testRuntime(agent = true) {
  const commands: Record<string, unknown>[] = [];
  const projection = {
    projects: [],
    worktrees: [{ worktreeId: "wt-1", projectId: "p", path: "/repo/app", branch: "feat-login", status: "ready" }],
    threads: agent
      ? [{ threadId: "t-1", worktreeId: "wt-1", status: "idle", createdAt: "2026-01-01T00:00:00.000Z" }]
      : [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  } as unknown as RuntimeProjection;
  const bridge = {
    runtime: {
      dispatch: async (request: { commandId: string; command: Record<string, unknown> }) => {
        commands.push(request.command);
        return { commandId: request.commandId, accepted: true, result: {} };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  return { bridge, commands, projection };
}

export function devContext(dev: unknown, extra: Partial<MobileDevContext> = {}): MobileDevContext {
  return {
    mobile: { dev } as unknown as MobileBridge,
    worktreeId: "wt-1",
    device: pixel,
    online: true,
    agentHolds: false,
    devServers: [],
    onError: vi.fn(),
    onNotice: vi.fn(),
    ...extra,
  };
}

let root: Root | undefined;

export async function render(node: ReactNode, bridge?: ZliBridge): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(bridge ? <RuntimeProvider bridge={bridge}>{node}</RuntimeProvider> : node));
  // The runtime store reads the projection after its first render.
  await act(async () => undefined);
  return container;
}

/** Renders new props into the same root, as when the panel switches worktrees or devices. */
export async function rerender(node: ReactNode, bridge?: ZliBridge): Promise<void> {
  await act(async () => root?.render(bridge ? <RuntimeProvider bridge={bridge}>{node}</RuntimeProvider> : node));
  await act(async () => undefined);
}

export function cleanup() {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
}

export function button(container: ParentNode, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

export async function click(element: HTMLElement) {
  await act(async () => element.click());
}
