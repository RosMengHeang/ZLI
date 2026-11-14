// @vitest-environment jsdom

import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { FileLinks } from "../files/FileIndex.js";
import { WorkSteps } from "./WorkLog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const step = (extra: Partial<ThreadActivityProjection>) =>
  ({
    activityId: "c1",
    threadId: "00000000-0000-4000-8000-000000000001",
    turnId: "t1",
    kind: "command",
    title: "Run tests",
    status: "completed",
    ...extra,
  }) as ThreadActivityProjection;

function render(activity: ThreadActivityProjection, links?: FileLinks) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(<WorkSteps activities={[activity]} links={links} />));
  act(() => host.querySelector<HTMLButtonElement>(".step-row")?.click());
  return host;
}

describe("WorkSteps output", () => {
  it("folds long output to its ends and opens it whole on request", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const host = render(step({ detail: output }));
    const pre = host.querySelector(".step-detail");
    const more = host.querySelector<HTMLButtonElement>(".step-more");
    expect(more?.textContent).toBe("… +14 lines");
    expect(pre?.textContent).not.toContain("line 4\n");
    expect(host.querySelector('.step-output button[aria-label="Copy"]')).not.toBeNull();
    act(() => more?.click());
    expect(host.querySelector(".step-more")).toBeNull();
    expect(host.querySelector(".step-detail")?.textContent).toBe(output);
  });

  it("shows a failed step's stack trace with its frames folded and worktree files linked", () => {
    const opened: unknown[] = [];
    const links: FileLinks = {
      find: () => [],
      resolve: (text) => (text.startsWith("/repo/src/") ? { path: "src/users.ts", line: 42, column: 17 } : undefined),
      open: (location) => opened.push(location),
      touch: () => undefined,
    };
    const host = render(
      step({
        status: "failed",
        detail: [
          "TypeError: boom",
          "    at loadUser (/repo/src/users.ts:42:17)",
          "    at run (/repo/node_modules/lib/index.js:1:1)",
        ].join("\n"),
      }),
      links,
    );
    expect(host.querySelector(".trace-type")?.textContent).toBe("TypeError");
    expect(host.querySelector(".trace-head")?.textContent).toBe("TypeError: boom");
    const toggle = host.querySelector<HTMLButtonElement>(".trace-toggle");
    expect(toggle?.textContent).toBe("2 frames");
    expect(host.querySelector(".trace-frames")).toBeNull();
    act(() => toggle?.click());
    const frames = [...host.querySelectorAll(".trace-frame")];
    expect(frames.map((frame) => frame.classList.contains("is-vendor"))).toEqual([false, true]);
    act(() => host.querySelector<HTMLButtonElement>(".trace-link")?.click());
    expect(opened).toEqual([{ path: "src/users.ts", line: 42, column: 17 }]);
  });
});
