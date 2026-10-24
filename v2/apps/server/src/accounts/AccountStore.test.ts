import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accountLoginArgs, signInStatus } from "./accountEnv.js";
import { AccountStore, keyHint } from "./AccountStore.js";

const KEY = "sk-test-0123456789abcdef";
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-accounts-"));
  dirs.push(dir);
  return dir;
}

async function makeStore(options: Partial<ConstructorParameters<typeof AccountStore>[0]> = {}) {
  const root = await tempDir();
  const store = new AccountStore({ path: join(root, "accounts.json"), dir: join(root, "accounts"), ...options });
  await store.load();
  return { store, root };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("AccountStore", () => {
  it("keeps API keys in an owner-only file and never lists them", async () => {
    const { store, root } = await makeStore();
    const result = await store.save({ provider: "claude-code", label: "Work", kind: "api-key", apiKey: KEY });
    expect(result.accounts).toEqual([
      { id: expect.any(String), provider: "claude-code", label: "Work", kind: "api-key", keyHint: "…cdef" },
    ]);
    expect(JSON.stringify(result)).not.toContain(KEY);
    const file = join(root, "accounts.json");
    expect(await readFile(file, "utf8")).toContain(KEY);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps the saved key when an edit leaves it out, and refuses a new key account without one", async () => {
    const { store } = await makeStore();
    const [account] = (await store.save({ provider: "gemini", label: "Team", kind: "api-key", apiKey: KEY })).accounts;
    if (!account) throw new Error("not saved");
    await store.save({ id: account.id, provider: "gemini", label: "Team two", kind: "api-key" });
    await expect(store.resolve("gemini", account.id)).resolves.toEqual({
      accountId: account.id,
      env: { GEMINI_API_KEY: KEY },
    });
    await expect(store.save({ provider: "gemini", label: "Empty", kind: "api-key" })).rejects.toThrow(
      "Add the API key.",
    );
  });

  it("rejects kinds an agent does not support", async () => {
    const { store } = await makeStore();
    await expect(store.save({ provider: "droid", label: "Login", kind: "sign-in" })).rejects.toThrow(
      "does not support sign-in",
    );
    await expect(store.save({ provider: "kimi", label: "Key", kind: "api-key", apiKey: KEY })).rejects.toThrow(
      "does not support API key",
    );
    await expect(store.save({ provider: "goose", label: "Key", kind: "api-key", apiKey: KEY })).rejects.toThrow();
  });

  it("resolves each provider's sign-in account to its config directory variable", async () => {
    const { store, root } = await makeStore();
    const expected = {
      codex: "CODEX_HOME",
      "claude-code": "CLAUDE_CONFIG_DIR",
      "cursor-agent": "CURSOR_CONFIG_DIR",
      gemini: "GEMINI_CLI_HOME",
      copilot: "COPILOT_HOME",
      kimi: "KIMI_CODE_HOME",
      qwen: "QWEN_HOME",
    } as const;
    for (const [provider, name] of Object.entries(expected) as [keyof typeof expected, string][]) {
      const { accounts } = await store.save({ provider, label: `${provider} login`, kind: "sign-in" });
      const account = accounts.find((entry) => entry.provider === provider);
      if (!account) throw new Error(`${provider} not saved`);
      expect(account.status).toBe("not-checked");
      const dir = join(root, "accounts", account.id);
      expect((await stat(dir)).isDirectory()).toBe(true);
      await expect(store.resolve(provider, account.id)).resolves.toEqual({
        accountId: account.id,
        env: { [name]: dir },
      });
    }
  });

  it("resolves API key accounts to each provider's key variable", async () => {
    const { store } = await makeStore();
    const expected = {
      "claude-code": "ANTHROPIC_API_KEY",
      "cursor-agent": "CURSOR_API_KEY",
      droid: "FACTORY_API_KEY",
      gemini: "GEMINI_API_KEY",
      copilot: "COPILOT_GITHUB_TOKEN",
    } as const;
    for (const [provider, name] of Object.entries(expected) as [keyof typeof expected, string][]) {
      const { accounts } = await store.save({ provider, label: "Key", kind: "api-key", apiKey: KEY });
      const account = accounts.find((entry) => entry.provider === provider);
      if (!account) throw new Error(`${provider} not saved`);
      await expect(store.resolve(provider, account.id)).resolves.toEqual({
        accountId: account.id,
        env: { [name]: KEY },
      });
    }
  });

  it("writes a Codex key into auth.json in the account's own CODEX_HOME", async () => {
    const { store, root } = await makeStore();
    const [account] = (await store.save({ provider: "codex", label: "Key", kind: "api-key", apiKey: KEY })).accounts;
    if (!account) throw new Error("not saved");
    const dir = join(root, "accounts", account.id);
    await expect(store.resolve("codex", account.id)).resolves.toEqual({
      accountId: account.id,
      env: { CODEX_HOME: dir },
    });
    const auth = join(dir, "auth.json");
    expect(JSON.parse(await readFile(auth, "utf8"))).toEqual({ OPENAI_API_KEY: KEY });
    if (process.platform !== "win32") expect((await stat(auth)).mode & 0o777).toBe(0o600);
  });

  it("uses the usual login unless a default is set, and refuses an account that was removed", async () => {
    const { store, root } = await makeStore();
    const [account] = (await store.save({ provider: "claude-code", label: "Work", kind: "sign-in" })).accounts;
    if (!account) throw new Error("not saved");
    await expect(store.resolve("claude-code")).resolves.toBeUndefined();

    const withDefault = await store.setDefault("claude-code", account.id);
    expect(withDefault.accounts[0]?.default).toBe(true);
    await expect(store.resolve("claude-code")).resolves.toMatchObject({ accountId: account.id });
    await expect(store.resolve("claude-code", "usual")).resolves.toBeUndefined();
    await expect(store.resolve("codex")).resolves.toBeUndefined();

    await store.setDefault("claude-code");
    await expect(store.resolve("claude-code")).resolves.toBeUndefined();

    await store.setDefault("claude-code", account.id);
    expect((await store.delete(account.id)).accounts).toEqual([]);
    await expect(store.resolve("claude-code")).resolves.toBeUndefined();
    await expect(store.resolve("claude-code", account.id)).rejects.toThrow("was removed");
    await expect(stat(join(root, "accounts", account.id))).rejects.toThrow();
  });

  it("refuses an account id that belongs to another provider", async () => {
    const { store } = await makeStore();
    const [account] = (await store.save({ provider: "gemini", label: "Key", kind: "api-key", apiKey: KEY })).accounts;
    if (!account) throw new Error("not saved");
    await expect(store.resolve("claude-code", account.id)).rejects.toThrow();
    await expect(store.setDefault("claude-code", account.id)).rejects.toThrow();
  });

  it("reloads saved accounts and defaults, and reports a damaged file", async () => {
    const { store, root } = await makeStore();
    const [account] = (await store.save({ provider: "copilot", label: "Work", kind: "sign-in" })).accounts;
    if (!account) throw new Error("not saved");
    await store.setDefault("copilot", account.id);

    const reloaded = new AccountStore({ path: join(root, "accounts.json"), dir: join(root, "accounts") });
    await reloaded.load();
    expect((await reloaded.list()).accounts).toEqual([{ ...account, default: true }]);

    await writeFile(join(root, "accounts.json"), "{ not json");
    const damaged = new AccountStore({ path: join(root, "accounts.json"), dir: join(root, "accounts") });
    await damaged.load();
    expect(await damaged.list()).toEqual({ accounts: [], problem: "The saved accounts are not valid JSON." });
  });

  it("copies MCP servers into a sign-in account's settings and remembers the names it owns", async () => {
    const calls: Array<{ provider: string; owned: readonly string[] }> = [];
    const { store } = await makeStore({
      syncMcp: async (provider, _dir, owned) => {
        calls.push({ provider, owned });
        return ["zli", "github"];
      },
    });
    const [account] = (await store.save({ provider: "gemini", label: "Login", kind: "sign-in" })).accounts;
    if (!account) throw new Error("not saved");
    await store.resolve("gemini", account.id);
    await store.resolve("gemini", account.id);
    expect(calls).toEqual([
      { provider: "gemini", owned: [] },
      { provider: "gemini", owned: ["zli", "github"] },
    ]);
  });

  it("does not let a broken MCP sync block the agent", async () => {
    const { store } = await makeStore({
      syncMcp: async () => {
        throw new Error("disk full");
      },
    });
    const [account] = (await store.save({ provider: "kimi", label: "Login", kind: "sign-in" })).accounts;
    if (!account) throw new Error("not saved");
    await expect(store.resolve("kimi", account.id)).resolves.toMatchObject({ accountId: account.id });
  });
});

describe("keyHint", () => {
  it("shows at most the last four characters", () => {
    expect(keyHint(KEY)).toBe("…cdef");
    expect(keyHint("short")).toBe("…");
  });
});

describe("account sign-in", () => {
  it("runs each CLI's own login, and none for agents without a sign-in", () => {
    expect(accountLoginArgs("codex")).toEqual(["login"]);
    expect(accountLoginArgs("cursor-agent")).toEqual(["login"]);
    expect(accountLoginArgs("copilot")).toEqual(["login"]);
    expect(accountLoginArgs("kimi")).toEqual(["login"]);
    expect(accountLoginArgs("claude-code")).toEqual([]);
    expect(accountLoginArgs("droid")).toBeUndefined();
    expect(accountLoginArgs("opencode")).toBeUndefined();
  });

  it("reports signed in only from files a sign-in leaves behind", async () => {
    const dir = await tempDir();
    await expect(signInStatus("codex", dir)).resolves.toBe("not-checked");
    await writeFile(join(dir, "auth.json"), "{}");
    await expect(signInStatus("codex", dir)).resolves.toBe("signed-in");

    await expect(signInStatus("claude-code", dir)).resolves.toBe("not-checked");
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
    await expect(signInStatus("claude-code", dir)).resolves.toBe("signed-in");

    await expect(signInStatus("copilot", dir)).resolves.toBe("not-checked");
  });
});
