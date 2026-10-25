import {
  ACCOUNT_SUPPORT,
  type Account,
  type AccountDraft,
  type AccountKind,
  AccountListResult,
  type ListedProviderKind,
  type RpcResponse,
  USUAL_LOGIN_ACCOUNT_ID,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

export const USUAL_LOGIN_LABEL = "Usual login";

export const accountKindLabel: Record<AccountKind, string> = {
  "sign-in": "Sign in",
  "api-key": "API key",
};

/** Agents that read MCP servers only from their own settings file, which a sign-in account moves. */
const SETTINGS_MCP_PROVIDERS: readonly ListedProviderKind[] = ["cursor-agent", "gemini", "kimi", "qwen"];

async function request(dispatch: Dispatch, command: Record<string, unknown>): Promise<AccountListResult> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const parsed = AccountListResult.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply. Restart ZLI and try again.");
  return parsed.data;
}

export function listAccounts(dispatch: Dispatch): Promise<AccountListResult> {
  return request(dispatch, { type: "accounts.list" });
}

export function saveAccount(dispatch: Dispatch, account: AccountDraft): Promise<AccountListResult> {
  return request(dispatch, { type: "accounts.save", account });
}

export function deleteAccount(dispatch: Dispatch, accountId: string): Promise<AccountListResult> {
  return request(dispatch, { type: "accounts.delete", accountId });
}

export function setDefaultAccount(
  dispatch: Dispatch,
  provider: ListedProviderKind,
  accountId: string,
): Promise<AccountListResult> {
  return request(dispatch, {
    type: "accounts.setDefault",
    provider,
    ...(accountId === USUAL_LOGIN_ACCOUNT_ID ? {} : { accountId }),
  });
}

export function supportsAccounts(provider: ListedProviderKind): boolean {
  const support = ACCOUNT_SUPPORT[provider];
  return support.signIn || support.apiKey;
}

export function accountsFor(accounts: readonly Account[], provider: string): Account[] {
  return accounts.filter((account) => account.provider === provider);
}

/** The account an agent gets when nobody picks one: the provider's default, or the usual login. */
export function defaultAccountId(accounts: readonly Account[], provider: string): string {
  return accountsFor(accounts, provider).find((account) => account.default)?.id ?? USUAL_LOGIN_ACCOUNT_ID;
}

/** Choices for the account picker. Empty when the provider has only the usual login, so no picker shows. */
export function accountOptions(
  accounts: readonly Account[],
  provider: string | undefined,
): { value: string; label: string }[] {
  const own = provider ? accountsFor(accounts, provider) : [];
  if (own.length === 0) return [];
  return [
    { value: USUAL_LOGIN_ACCOUNT_ID, label: USUAL_LOGIN_LABEL },
    ...own.map((account) => ({ value: account.id, label: account.label })),
  ];
}

/**
 * The account id a launch sends. It names the account even when it is the default, so a later change
 * of default does not move an agent that is resumed to another login.
 */
export function launchAccountId(
  accounts: readonly Account[],
  provider: string,
  picked: string | undefined,
): string | undefined {
  const own = accountsFor(accounts, provider);
  if (own.length === 0) return undefined;
  if (picked === USUAL_LOGIN_ACCOUNT_ID || own.some((account) => account.id === picked)) return picked;
  return defaultAccountId(accounts, provider);
}

/**
 * The label to show for an agent's account. Undefined for the usual login, which needs no label, and
 * while the list is still loading (`accounts` undefined), so a saved account never flashes as removed.
 */
export function accountLabel(
  accounts: readonly Account[] | undefined,
  accountId: string | undefined,
): string | undefined {
  if (!accounts || !accountId || accountId === USUAL_LOGIN_ACCOUNT_ID) return undefined;
  return accounts.find((account) => account.id === accountId)?.label ?? "Removed account";
}

export function sessionAccountId(session: {
  thread?: { accountId?: string | undefined } | undefined;
  terminal?: { agent?: { accountId?: string | undefined } | undefined } | undefined;
  pending?: { accountId?: string | undefined } | undefined;
}): string | undefined {
  return session.thread?.accountId ?? session.terminal?.agent?.accountId ?? session.pending?.accountId;
}

/** What a person should know about how an account changes the agent's setup. */
export function accountNote(account: Pick<Account, "provider" | "kind">): string | undefined {
  if (account.kind === "api-key") {
    return account.provider === "codex"
      ? "Uses its own Codex settings and history, not your usual ones."
      : "Uses your usual settings with this key.";
  }
  if (SETTINGS_MCP_PROVIDERS.includes(account.provider)) {
    return "Uses its own settings. ZLI copies its MCP servers into them when an agent starts.";
  }
  return "Uses its own settings and history, not your usual ones.";
}

export function validateDraft(draft: { label: string; kind: AccountKind; apiKey: string }, isNew: boolean) {
  if (!draft.label.trim()) return "Add a name for this account.";
  if (draft.kind === "api-key" && isNew && !draft.apiKey.trim()) return "Add the API key.";
  return undefined;
}

export type AccountsState =
  | { status: "loading" }
  | { status: "ready"; result: AccountListResult }
  | { status: "error"; message: string };

const EMPTY: readonly Account[] = [];
let shared: AccountsState = { status: "loading" };
let loadedFor: Dispatch | undefined;
const listeners = new Set<() => void>();

function publish(next: AccountsState): void {
  shared = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function refresh(dispatch: Dispatch): Promise<void> {
  try {
    publish({ status: "ready", result: await listAccounts(dispatch) });
  } catch (error) {
    publish({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

/** Forgets the shared list, for tests that start a new runtime. */
export function resetAccountsStore(): void {
  loadedFor = undefined;
  publish({ status: "loading" });
}

/** One list for the whole window, so the New agent dialog sees an account the moment Settings adds it. */
export function useAccounts(): {
  state: AccountsState;
  accounts: readonly Account[];
  reload(): void;
  save(account: AccountDraft): Promise<AccountListResult>;
  remove(accountId: string): Promise<AccountListResult>;
  setDefault(provider: ListedProviderKind, accountId: string): Promise<AccountListResult>;
} {
  const { dispatch } = useRuntime();
  const state = useSyncExternalStore(subscribe, () => shared);

  useEffect(() => {
    if (loadedFor === dispatch) return;
    loadedFor = dispatch;
    void refresh(dispatch);
  }, [dispatch]);

  const apply = useCallback(async (work: Promise<AccountListResult>) => {
    const result = await work;
    publish({ status: "ready", result });
    return result;
  }, []);

  return {
    state,
    accounts: state.status === "ready" ? state.result.accounts : EMPTY,
    reload: () => {
      publish({ status: "loading" });
      void refresh(dispatch);
    },
    save: (account) => apply(saveAccount(dispatch, account)),
    remove: (accountId) => apply(deleteAccount(dispatch, accountId)),
    setDefault: (provider, accountId) => apply(setDefaultAccount(dispatch, provider, accountId)),
  };
}
