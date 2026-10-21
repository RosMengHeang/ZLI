// @vitest-environment jsdom

import type { DevServerProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevServerBar, DevServerChip, devServerCommands, devServerLabel } from "./DevServers.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function server(url: string, port: number): DevServerProjection {
  return {
    worktreeId: "00000000-0000-4000-8000-000000000011" as DevServerProjection["worktreeId"],
    terminalId: "00000000-0000-4000-8000-000000000031" as DevServerProjection["terminalId"],
    url,
    port,
    detectedAt: "2026-01-01T00:00:00.000Z",
  };
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

describe("dev server UI", () => {
  it("labels a server by host and port, adding the path only when there is one", () => {
    expect(devServerLabel("http://localhost:5173/")).toBe("localhost:5173");
    expect(devServerLabel("http://127.0.0.1:4321/docs/")).toBe("127.0.0.1:4321/docs/");
  });

  it("opens the newest server from the topbar chip and counts the others", () => {
    const onOpen = vi.fn();
    const container = render(
      <DevServerChip
        devServers={[server("http://localhost:5173/", 5173), server("http://localhost:6006/", 6006)]}
        onOpen={onOpen}
      />,
    );
    const chip = container.querySelector("button");
    expect(chip?.getAttribute("aria-label")).toBe("Open localhost:5173 in the browser panel");
    expect(chip?.textContent).toBe("localhost:5173+1");
    act(() => chip?.click());
    expect(onOpen).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("renders nothing without servers", () => {
    expect(render(<DevServerChip devServers={[]} onOpen={() => undefined} />).childElementCount).toBe(0);
  });

  it("offers a server only while the current tab shows another origin", () => {
    const devServers = [server("http://localhost:5173/", 5173)];
    const onOpen = vi.fn();
    const showing = render(
      <DevServerBar devServers={devServers} currentUrl="http://localhost:5173/settings" busy={false} onOpen={onOpen} />,
    );
    expect(showing.childElementCount).toBe(0);
    act(() => root?.unmount());

    const elsewhere = render(
      <DevServerBar devServers={devServers} currentUrl="https://example.com/" busy={false} onOpen={onOpen} />,
    );
    expect(elsewhere.textContent).toContain("Dev server on localhost:5173");
    act(() => elsewhere.querySelector("button")?.click());
    expect(onOpen).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("adds one palette command per server", () => {
    const open = vi.fn();
    const commands = devServerCommands([server("http://localhost:5173/", 5173)], open);
    expect(commands.map((command) => command.label)).toEqual(["Open localhost:5173 in the browser"]);
    commands[0]?.action();
    expect(open).toHaveBeenCalledWith("http://localhost:5173/");
  });
});
