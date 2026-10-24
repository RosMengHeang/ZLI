import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  ACCOUNT_SUPPORT,
  type Account,
  AccountDraft,
  AccountId,
  type AccountKind,
  type AccountListResult,
  ListedProviderKind,
  MAX_ACCOUNTS,
  USUAL_LOGIN_ACCOUNT_ID,
} from "@zli-v2/contracts";

import { isPlainObject } from "../browser-tool/browserTool.js";
import { API_KEY_ENV, CONFIG_DIR_ENV, signInStatus } from "./accountEnv.js";

type StoredAccount = {
  id: string;
  provider: ListedProviderKind;
  label: string;
  kind: AccountKind;
  apiKey?: string;
  /** MCP server names ZLI wrote into this account's own settings file. */
  mcpOwned?: string[];
};

type StoredFile = { version: 1; accounts: StoredAccount[]; defaults: Partial<Record<ListedProviderKind, string>> };

/** The environment an agent process runs with for one account, merged over ZLI's own. */
export type AccountLaunch = { accountId: string; env: Record<string, string> };

export type AccountResolver = (provider: ListedProviderKind, accountId?: string) => Promise<AccountLaunch | undefined>;

/** Copies ZLI's MCP servers into a sign-in account's own settings; returns the names ZLI now owns there. */
export type AccountMcpSync = (
  provider: ListedProviderKind,
  configDir: string,
  owned: readonly string[],
) => Promise<string[] | undefined>;

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

/**
 * Named identities per agent CLI, kept in one JSON file beside the database. The file holds API keys,
 * so it is written owner-only and keys never appear in `list()`.
 */
export class AccountStore {
  private accounts: StoredAccount[] = [];
  private defaults: Partial<Record<ListedProviderKind, string>> = {};
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      path: string;
      /** Parent of each sign-in account's private config directory. */
      dir: string;
      syncMcp?: AccountMcpSync;
    },
  ) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      this.problem = "The saved accounts could not be read.";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      this.problem = "The saved accounts are not valid JSON.";
      return;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.accounts)) {
      this.problem = "The saved accounts are not valid.";
      return;
    }
    this.accounts = parsed.accounts.flatMap((value) => {
      const account = storedAccount(value);
      return account ? [account] : [];
    });
    this.defaults = {};
    if (isPlainObject(parsed.defaults)) {
      for (const [provider, id] of Object.entries(parsed.defaults)) {
        const kind = ListedProviderKind.safeParse(provider);
        if (kind.success && this.accounts.some((account) => account.id === id && account.provider === kind.data)) {
          this.defaults[kind.data] = id as string;
        }
      }
    }
  }

  async list(): Promise<AccountListResult> {
    const accounts = await Promise.all(this.accounts.map((account) => this.publicAccount(account)));
    return { accounts, ...(this.problem ? { problem: this.problem } : {}) };
  }

  save(input: AccountDraft): Promise<AccountListResult> {
    return this.serialize(async () => {
      const draft = AccountDraft.parse(input);
      const support = ACCOUNT_SUPPORT[draft.provider];
      if (draft.kind === "sign-in" ? !support.signIn : !support.apiKey) {
        throw new AccountError(
          `This agent does not support ${draft.kind === "sign-in" ? "sign-in" : "API key"} accounts.`,
        );
      }
      const existing = draft.id ? this.accounts.find((account) => account.id === draft.id) : undefined;
      if (draft.id && !existing) throw new AccountError("This account no longer exists.");
      if (existing && (existing.provider !== draft.provider || existing.kind !== draft.kind)) {
        throw new AccountError("An account keeps its agent and kind. Add a new account instead.");
      }
      if (!existing && this.accounts.length >= MAX_ACCOUNTS) throw new AccountError("There are too many accounts.");
      const apiKey = draft.kind === "api-key" ? (draft.apiKey ?? existing?.apiKey) : undefined;
      if (draft.kind === "api-key" && !apiKey) throw new AccountError("Add the API key.");
      const next: StoredAccount = {
        id: existing?.id ?? randomUUID(),
        provider: draft.provider,
        label: draft.label,
        kind: draft.kind,
        ...(apiKey ? { apiKey } : {}),
        ...(existing?.mcpOwned ? { mcpOwned: existing.mcpOwned } : {}),
      };
      const accounts = existing
        ? this.accounts.map((account) => (account.id === existing.id ? next : account))
        : [...this.accounts, next];
      await this.write(accounts, this.defaults);
      this.accounts = accounts;
      this.problem = undefined;
      if (next.kind === "sign-in") await this.ensureDir(next.id);
      return this.list();
    });
  }

  delete(accountId: string): Promise<AccountListResult> {
    return this.serialize(async () => {
      const account = this.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new AccountError("This account no longer exists.");
      const accounts = this.accounts.filter((candidate) => candidate.id !== accountId);
      const defaults = { ...this.defaults };
      if (defaults[account.provider] === accountId) delete defaults[account.provider];
      await this.write(accounts, defaults);
      this.accounts = accounts;
      this.defaults = defaults;
      // The directory holds the account's login; a leftover folder is harmless but would keep it signed in.
      await rm(this.accountDir(accountId), { recursive: true, force: true }).catch(() => undefined);
      return this.list();
    });
  }

  setDefault(provider: ListedProviderKind, accountId?: string): Promise<AccountListResult> {
    return this.serialize(async () => {
      const defaults = { ...this.defaults };
      if (accountId === undefined || accountId === USUAL_LOGIN_ACCOUNT_ID) delete defaults[provider];
      else {
        const account = this.accounts.find((candidate) => candidate.id === accountId);
        if (!account || account.provider !== provider) throw new AccountError("This account no longer exists.");
        defaults[provider] = accountId;
      }
      await this.write(this.accounts, defaults);
      this.defaults = defaults;
      return this.list();
    });
  }

  /**
   * The environment for an agent started with `accountId`, or with the provider's default when it is
   * omitted. Undefined means the person's usual login. A named account that is gone is an error, so an
   * agent never quietly runs as someone else.
   */
  async resolve(provider: ListedProviderKind, accountId?: string): Promise<AccountLaunch | undefined> {
    if (accountId === USUAL_LOGIN_ACCOUNT_ID) return undefined;
    const id = accountId ?? this.defaults[provider];
    if (id === undefined) return undefined;
    const account = this.accounts.find((candidate) => candidate.id === id);
    if (!account || account.provider !== provider) {
      throw new AccountError("The account for this agent was removed. Start it with another account.");
    }
    return { accountId: account.id, env: await this.launchEnv(account) };
  }

  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  accountDir(accountId: string): string {
    const parent = resolve(this.options.dir);
    const dir = resolve(parent, AccountId.parse(accountId));
    const inside = relative(parent, dir);
    if (!inside || inside.startsWith("..")) throw new AccountError("The account folder is not valid.");
    return dir;
  }

  private async launchEnv(account: StoredAccount): Promise<Record<string, string>> {
    if (account.kind === "api-key") {
      const key = account.apiKey ?? "";
      if (account.provider === "codex") {
        const dir = await this.ensureDir(account.id);
        await writePrivate(join(dir, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: key }, null, 2)}\n`);
        return { CODEX_HOME: dir };
      }
      const name = API_KEY_ENV[account.provider];
      if (!name) throw new AccountError("This agent does not support API key accounts.");
      return { [name]: key };
    }
    const name = CONFIG_DIR_ENV[account.provider];
    if (!name) throw new AccountError("This agent does not support sign-in accounts.");
    const dir = await this.ensureDir(account.id);
    await this.syncMcp(account, dir);
    return { [name]: dir };
  }

  /** MCP servers are extras, so a failure here never blocks the agent. */
  private async syncMcp(account: StoredAccount, dir: string): Promise<void> {
    const sync = this.options.syncMcp;
    if (!sync) return;
    let owned: string[] | undefined;
    try {
      owned = await sync(account.provider, dir, account.mcpOwned ?? []);
    } catch {
      return;
    }
    if (!owned || sameNames(owned, account.mcpOwned ?? [])) return;
    await this.serialize(async () => {
      const accounts = this.accounts.map((candidate) =>
        candidate.id === account.id ? { ...candidate, mcpOwned: owned } : candidate,
      );
      await this.write(accounts, this.defaults);
      this.accounts = accounts;
    }).catch(() => undefined);
  }

  private async ensureDir(accountId: string): Promise<string> {
    const dir = this.accountDir(accountId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async publicAccount(account: StoredAccount): Promise<Account> {
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      kind: account.kind,
      ...(this.defaults[account.provider] === account.id ? { default: true } : {}),
      ...(account.apiKey ? { keyHint: keyHint(account.apiKey) } : {}),
      ...(account.kind === "sign-in"
        ? { status: await signInStatus(account.provider, this.accountDir(account.id)) }
        : {}),
    };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }

  private async write(accounts: StoredAccount[], defaults: Partial<Record<ListedProviderKind, string>>): Promise<void> {
    const file: StoredFile = { version: 1, accounts, defaults };
    await writePrivate(this.options.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

/** Shows enough of a key to tell two apart, and never more than four characters. */
export function keyHint(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}

/** Owner-only atomic write, for files that hold keys. */
async function writePrivate(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
    // rename keeps the temp file's mode, but an older file at the same path may have been wider.
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function storedAccount(value: unknown): StoredAccount | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = AccountId.safeParse(value.id);
  const provider = ListedProviderKind.safeParse(value.provider);
  if (!id.success || id.data === USUAL_LOGIN_ACCOUNT_ID || !provider.success) return undefined;
  if (value.kind !== "sign-in" && value.kind !== "api-key") return undefined;
  if (typeof value.label !== "string" || value.label.trim().length === 0) return undefined;
  const apiKey = typeof value.apiKey === "string" && value.apiKey.length > 0 ? value.apiKey : undefined;
  if (value.kind === "api-key" && !apiKey) return undefined;
  const mcpOwned = Array.isArray(value.mcpOwned)
    ? value.mcpOwned.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  return {
    id: id.data,
    provider: provider.data,
    label: value.label.trim().slice(0, 60),
    kind: value.kind,
    ...(value.kind === "api-key" && apiKey ? { apiKey } : {}),
    ...(mcpOwned.length > 0 ? { mcpOwned } : {}),
  };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
