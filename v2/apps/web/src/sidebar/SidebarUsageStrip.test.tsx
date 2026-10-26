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
const recent = new Date(now - 60_000).toISOString();
let turn = 0;

function usage(provider: string, values: ThreadUsageRecord["usage"], accountId?: string): ThreadUsageRecord {
  turn += 1;
  const threadId = ThreadId.parse(`00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`);
  return {
    usageId: `${threadId}:t${turn}`,
    threadId,
    turnId: `t${turn}`,
    provider,
    recordedAt: recent,
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
  it("is a quiet Usage button when nothing is recorded", async () => {
    let opened = 0;
    const button = await render([], { onOpen: () => (opened += 1) });
    expect(button.getAttribute("aria-label")).toBe("Usage");
    expect(button.textContent).toBe("No usage yet");
    await act(async () => button.click());
    expect(opened).toBe(1);
  });

  it("shows one row without an account chip for the usual login", async () => {
    const button = await render([usage("codex", { inputTokens: 1_200, outputTokens: 100 })]);
    const rows = button.querySelectorAll(".usage-strip-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("Codex1.3k tokens");
    expect(button.querySelector(".usage-strip-account")).toBeNull();
    expect(button.querySelector(".usage-strip-bar")).toBeNull();
    expect(button.querySelector(".usage-strip-head")?.textContent).toBe("Today1.3k tokens");
    expect(description(button)).toBe("Today, 1.3k tokens in all. Codex: 1.3k tokens.");
  });

  it("gives each account a row, names the usual login beside saved ones, and caps at three", async () => {
    const button = await render(
      [
        usage("claude-code", { inputTokens: 500, costUsd: 1.2 }, "work"),
        usage("claude-code", { inputTokens: 300, costUsd: 0.4 }),
        usage("codex", { inputTokens: 9_000 }, "gone"),
        usage("codex", { inputTokens: 100 }),
      ],
      { currentKey: "claude-code:work" },
    );
    const rows = [...button.querySelectorAll(".usage-strip-row")].map((row) => row.textContent);
    expect(rows).toEqual(["Claude CodeWork$1.20", "Claude CodeUsual login$0.40", "CodexRemoved account9k tokens"]);
    expect(button.querySelector(".usage-strip-row.is-current")?.textContent).toContain("Work");
    expect(button.querySelector(".usage-strip-more")?.textContent).toBe("+1 more");
    expect(button.querySelectorAll(".usage-strip-bar")).toHaveLength(3);
    expect(description(button)).toContain("Claude Code, Work: $1.20, selected agent.");
    expect(description(button)).toContain("1 more.");
  });

  it("never names an account as removed while the list is loading", async () => {
    const button = await render([usage("claude-code", { inputTokens: 500 }, "work")], { accounts: undefined });
    expect(button.textContent).not.toContain("Removed account");
  });
});
