// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MobileDevice } from "@zli-v2/contracts";

import { MobileLogsDrawer } from "./MobileLogsDrawer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.sessionStorage.clear();
});

describe("logs drawer crash marks", () => {
  it("marks the lines of a crash block in red", async () => {
    window.sessionStorage.setItem("zli.mobile.logs.v1", "open");
    const lines = [
      "11-01 10:00:00.000  100  100 I ActivityManager: Start proc 100:com.example.app/u0a1 for activity",
      "11-01 10:00:01.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main",
      "11-01 10:00:01.001  100  100 E AndroidRuntime: java.lang.RuntimeException: boom",
      "11-01 10:00:01.002  100  100 E AndroidRuntime: \tat com.example.app.Main.run(Main.kt:1)",
      "11-01 10:00:02.000  200  200 I Other   : later",
    ];
    const mobile = { logs: vi.fn(async () => lines) };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <MobileLogsDrawer
          mobile={mobile}
          device={{ deviceId: "d", name: "Pixel" } as MobileDevice}
          inputBlocked={false}
          onBlockedInput={() => undefined}
          onNotice={() => undefined}
        />,
      ),
    );
    const spans = [...container.querySelectorAll(".mobile-logs-list > span")];
    expect(spans.map((span) => span.classList.contains("is-crash"))).toEqual([false, true, true, true, false]);
    expect(container.querySelector(".mobile-logs-list")?.textContent).toBe(lines.join("\n"));
  });
});
