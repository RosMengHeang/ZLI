// @vitest-environment jsdom

import {
  type Account,
  CommandId,
  EnvironmentId,
  type RuntimeProjection,
  ThreadId,
  type ThreadUsageRecord,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { SidebarUsageStrip } from "./SidebarUsageStrip.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const now = Date.now();
let turn = 0;

function usage(
  provider: string,
  values: ThreadUsageRecord["usage"],
  accountId?: string,
  hoursAgo = 0.02,
): ThreadUsageRecord {
  turn += 1;
  const threadId = ThreadId.parse(`00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`);
  return {
    usageId: `${threadId}:t${turn}`,
    threadId,
    turnId: `t${turn}`,
    provider,
    recordedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
    usage: values,
    ...(accountId ? { accountId } : {}),
  };
}

function projectionWith(records: ThreadUsageRecord[]): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "claude" },
      { provider: "codex", displayName: "Codex", status: "found", path: "codex" },
    ],
    usage: records,
  };
}

const work = { id: "work", provider: "claude-code", kind: "sign-in", label: "Work" } as Account;

async function render(
  records: ThreadUsageRecord[],
  options: { accounts?: readonly Account[] | undefined; currentKey?: string; onOpen?: () => void } = {},
) {
  const projection = projectionWith(records);
  const bridge = {
    runtime: {
      dispatch: async () => ({ commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true }),
      getProjection: async () => projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <SidebarUsageStrip
          providers={projection.providers}
          accounts={"accounts" in options ? options.accounts : [work]}
          now={now}
          currentKey={options.currentKey}
          onOpen={options.onOpen ?? (() => undefined)}
        />
      </RuntimeProvider>,
    );
  });
  const button = container.querySelector("button");
  if (!button) throw new Error("No usage strip");
  return button;
}

function description(button: HTMLButtonElement): string {
  const id = button.getAttribute("aria-describedby");
  return (id && document.getElementById(id)?.textContent) || "";
}

afterEach(() => document.body.replaceChildren());

describe("SidebarUsageStrip", () => {
  it("is a quiet Token usage button when nothing is recorded", async () => {
    let opened = 0;
    const button = await render([], { onOpen: () => (opened += 1) });
    expect(button.getAttribute("aria-label")).toBe("Token usage");
    expect(button.textContent).toBe("No usage yet");
    await act(async () => button.click());
    expect(opened).toBe(1);
  });

  it("says so when the only usage is older than 7 days", async () => {
    const button = await render([usage("codex", { inputTokens: 100 }, undefined, 24 * 9)]);
    expect(button.textContent).toBe("No tokens in the last 7 days");
  });

  it("shows tokens for the last 5 hours and the week, never cost", async () => {
    const button = await render([
      usage("codex", { inputTokens: 1_200, outputTokens: 100, costUsd: 0.5 }),
      usage("codex", { inputTokens: 4_000 }, undefined, 30),
    ]);
    const rows = button.querySelectorAll(".usage-strip-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("Codex1.3k5.3k");
    expect(button.textContent).not.toContain("$");
    expect(button.querySelector(".usage-strip-account")).toBeNull();
    expect(description(button)).toBe(
      "Tokens in the last 5 hours and the last 7 days. Codex: 1.3k in 5 hours, 5.3k this week.",
    );
  });

  it("gives each account a row, busiest in 5 hours first, and caps at three", async () => {
    const button = await render(
      [
        usage("claude-code", { inputTokens: 500 }, "work"),
        usage("claude-code", { inputTokens: 300 }),
        usage("codex", { inputTokens: 9_000 }, "gone", 10),
        usage("codex", { inputTokens: 100 }),
      ],
      { currentKey: "claude-code:work" },
    );
    const rows = [...button.querySelectorAll(".usage-strip-row")].map((row) => row.textContent);
    expect(rows).toEqual(["Claude CodeWork500500", "Claude CodeUsual login300300", "CodexUsual login100100"]);
    expect(button.querySelector(".usage-strip-row.is-current")?.textContent).toContain("Work");
    expect(button.querySelector(".usage-strip-more")?.textContent).toBe("+1 more");
    expect(description(button)).toContain("Claude Code, Work: 500 in 5 hours, 500 this week, selected agent.");
    expect(description(button)).toContain("1 more.");
  });

  it("names a deleted account as removed, but not while the list is loading", async () => {
    const records = [usage("codex", { inputTokens: 900 }, "gone")];
    expect((await render(records)).textContent).toContain("Removed account");
    document.body.replaceChildren();
    expect((await render(records, { accounts: undefined })).textContent).not.toContain("Removed account");
  });
});
