import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SUPPORT,
  AccountCommand,
  AccountDraft,
  accountKinds,
  RpcRequest,
  TerminalAgentLaunch,
  ThreadProjection,
  ThreadUsageRecord,
} from "./index.js";

const threadId = "50000000-0000-4000-8000-000000000001";
const worktreeId = "60000000-0000-4000-8000-000000000001";

describe("account contracts", () => {
  it("reads thread, usage, and terminal records saved before accounts existed", () => {
    const thread = ThreadProjection.parse({
      threadId,
      worktreeId,
      provider: "codex",
      status: "idle",
      capabilities: {},
    });
    expect(thread.accountId).toBeUndefined();
    expect(
      ThreadUsageRecord.parse({ usageId: "u", threadId, turnId: "t", provider: "codex", usage: {} }).accountId,
    ).toBeUndefined();
    expect(TerminalAgentLaunch.parse({ provider: "claude-code" })).toEqual({ provider: "claude-code" });
  });

  it("starts a thread with or without an account", () => {
    const start = (extra: Record<string, unknown>) =>
      RpcRequest.parse({
        protocolVersion: 1,
        commandId: "10000000-0000-4000-8000-000000000001",
        command: { type: "thread.start", threadId, worktreeId, provider: "codex", cwd: "/tree", ...extra },
      }).command;
    expect(start({})).not.toHaveProperty("accountId");
    expect(start({ accountId: "work" })).toMatchObject({ accountId: "work" });
    expect(() => start({ accountId: "../other" })).toThrow();
  });

  it("accepts account commands as runtime requests", () => {
    const request = RpcRequest.parse({
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000002",
      command: { type: "accounts.setDefault", provider: "gemini" },
    });
    expect(AccountCommand.parse(request.command)).toEqual({ type: "accounts.setDefault", provider: "gemini" });
  });

  it("requires a name for every account", () => {
    expect(() => AccountDraft.parse({ provider: "codex", label: "  ", kind: "sign-in" })).toThrow();
  });

  it("offers only the kinds each agent supports", () => {
    expect(accountKinds("codex")).toEqual(["sign-in", "api-key"]);
    expect(accountKinds("droid")).toEqual(["api-key"]);
    expect(accountKinds("kimi")).toEqual(["sign-in"]);
    expect(accountKinds("goose")).toEqual([]);
    expect(ACCOUNT_SUPPORT.opencode).toEqual({ signIn: false, apiKey: false });
  });
});
