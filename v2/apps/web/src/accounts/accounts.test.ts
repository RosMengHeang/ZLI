import type { Account } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  accountLabel,
  accountNote,
  accountOptions,
  defaultAccountId,
  launchAccountId,
  sessionAccountId,
  supportsAccounts,
  validateDraft,
} from "./accounts.js";

const accounts: Account[] = [
  { id: "work", provider: "codex", label: "Work", kind: "api-key", keyHint: "…1234" },
  { id: "home", provider: "codex", label: "Home", kind: "sign-in", default: true, status: "signed-in" },
  { id: "team", provider: "claude-code", label: "Team", kind: "sign-in" },
];

describe("account helpers", () => {
  it("shows a picker only for agents with saved accounts", () => {
    expect(accountOptions(accounts, "codex")).toEqual([
      { value: "usual", label: "Usual login" },
      { value: "work", label: "Work" },
      { value: "home", label: "Home" },
    ]);
    expect(accountOptions(accounts, "gemini")).toEqual([]);
    expect(accountOptions(accounts, undefined)).toEqual([]);
  });

  it("starts with the default account, or the usual login when there is none", () => {
    expect(defaultAccountId(accounts, "codex")).toBe("home");
    expect(defaultAccountId(accounts, "claude-code")).toBe("usual");
  });

  it("names the account at launch so a later default change does not move the agent", () => {
    expect(launchAccountId(accounts, "codex", undefined)).toBe("home");
    expect(launchAccountId(accounts, "codex", "work")).toBe("work");
    expect(launchAccountId(accounts, "codex", "usual")).toBe("usual");
    expect(launchAccountId(accounts, "codex", "team")).toBe("home");
    expect(launchAccountId(accounts, "claude-code", undefined)).toBe("usual");
    expect(launchAccountId(accounts, "gemini", undefined)).toBeUndefined();
  });

  it("labels only saved accounts, and not while the list is loading", () => {
    expect(accountLabel(accounts, "work")).toBe("Work");
    expect(accountLabel(accounts, "usual")).toBeUndefined();
    expect(accountLabel(accounts, undefined)).toBeUndefined();
    expect(accountLabel(accounts, "gone")).toBe("Removed account");
    expect(accountLabel(undefined, "work")).toBeUndefined();
  });

  it("reads the account from the thread, then the terminal, then the pending launch", () => {
    expect(sessionAccountId({ thread: { accountId: "a" }, pending: { accountId: "b" } })).toBe("a");
    expect(sessionAccountId({ terminal: { agent: { accountId: "c" } } })).toBe("c");
    expect(sessionAccountId({ pending: { accountId: "b" } })).toBe("b");
    expect(sessionAccountId({})).toBeUndefined();
  });

  it("knows which agents support accounts and explains what each kind changes", () => {
    expect(supportsAccounts("codex")).toBe(true);
    expect(supportsAccounts("opencode")).toBe(false);
    expect(accountNote({ provider: "codex", kind: "api-key" })).toContain("own Codex settings");
    expect(accountNote({ provider: "claude-code", kind: "api-key" })).toBe("Uses your usual settings with this key.");
    expect(accountNote({ provider: "gemini", kind: "sign-in" })).toContain("MCP servers");
  });

  it("asks for a name, and a key for a new API key account", () => {
    expect(validateDraft({ label: " ", kind: "sign-in", apiKey: "" }, true)).toBe("Add a name for this account.");
    expect(validateDraft({ label: "Work", kind: "api-key", apiKey: "" }, true)).toBe("Add the API key.");
    expect(validateDraft({ label: "Work", kind: "api-key", apiKey: "" }, false)).toBeUndefined();
  });
});
