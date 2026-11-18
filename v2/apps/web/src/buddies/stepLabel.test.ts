import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { friendlyStep, friendlySteps } from "./stepLabel.js";

const step = (kind: ThreadActivityProjection["kind"], title: string, extra: Partial<ThreadActivityProjection> = {}) =>
  ({
    activityId: `${kind}-${title}`,
    threadId: "t1",
    kind,
    title,
    status: "running",
    ...extra,
  }) as ThreadActivityProjection;

describe("friendlyStep", () => {
  it("never shows a raw command line or path", () => {
    const label = friendlyStep(
      step(
        "command",
        '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content \'C:\\\\Users\\\\me\\\\SKILL.md\'"',
      ),
    );
    expect(label).toBe("Reading files");
    expect(friendlyStep(step("command", "pnpm test"))).toBe("Running the tests");
    expect(friendlyStep(step("command", "make build"))).toBe("Running a command");
  });

  it("says what the buddy does on the web and in its browser", () => {
    expect(friendlyStep(step("web", "Fetch https://zli.taxzy.dev"))).toBe("Reading zli.taxzy.dev");
    expect(
      friendlyStep(step("tool", "mcp__zli-browser__browser_open", { detail: '{"url":"https://www.youtube.com/"}' })),
    ).toBe("Opening youtube.com");
    expect(friendlyStep(step("tool", "mcp__zli-browser__browser_snapshot"))).toBe("Reading the page");
    expect(friendlyStep(step("search", "Search select:mcp__zli-browser__browser_open"))).toBe("Getting my tools ready");
    expect(friendlyStep(step("tool", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"))).toBe("Using your apps");
    expect(friendlyStep(step("tool", "mcp__zli__message_agent"))).toBe("Messaging a teammate");
  });

  it("folds repeats, so Thinking shows once", () => {
    expect(friendlySteps([step("reasoning", "Thinking"), step("reasoning", "Thinking", { activityId: "r2" })])).toEqual(
      [{ id: "reasoning-Thinking", label: "Thinking" }],
    );
  });
});
