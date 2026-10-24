import { z } from "zod";

import { AccountId } from "./ids.js";
import { ListedProviderKind } from "./provider.js";

export const AccountKind = z.enum(["sign-in", "api-key"]);
export type AccountKind = z.infer<typeof AccountKind>;

/** Stands for the person's own login: the agent starts with ZLI's environment, as before accounts existed. */
export const USUAL_LOGIN_ACCOUNT_ID = "usual";
export const MAX_ACCOUNTS = 100;
export const MAX_ACCOUNT_LABEL = 60;

/**
 * Which kinds of account each agent CLI can run under. Sign in needs a documented config directory
 * variable, and API key needs a documented key variable or key file.
 */
export const ACCOUNT_SUPPORT: Readonly<Record<ListedProviderKind, { signIn: boolean; apiKey: boolean }>> = {
  codex: { signIn: true, apiKey: true },
  "claude-code": { signIn: true, apiKey: true },
  "cursor-agent": { signIn: true, apiKey: true },
  droid: { signIn: false, apiKey: true },
  opencode: { signIn: false, apiKey: false },
  gemini: { signIn: true, apiKey: true },
  copilot: { signIn: true, apiKey: true },
  kimi: { signIn: true, apiKey: false },
  qwen: { signIn: true, apiKey: false },
  goose: { signIn: false, apiKey: false },
};

export function accountKinds(provider: ListedProviderKind): AccountKind[] {
  const support = ACCOUNT_SUPPORT[provider];
  return [...(support.signIn ? (["sign-in"] as const) : []), ...(support.apiKey ? (["api-key"] as const) : [])];
}

/** A named identity for one agent CLI. API keys never leave the runtime; `keyHint` is all a client sees. */
export const Account = z.object({
  id: AccountId,
  provider: ListedProviderKind,
  label: z.string().trim().min(1).max(MAX_ACCOUNT_LABEL),
  kind: AccountKind,
  /** Used when an agent starts without naming an account. */
  default: z.boolean().optional(),
  /** The key's last four characters. */
  keyHint: z.string().max(12).optional(),
  /** Sign-in accounts only. "not-checked" means ZLI cannot tell from the files on disk. */
  status: z.enum(["signed-in", "not-checked"]).optional(),
});
export type Account = z.infer<typeof Account>;

/** A new account has no id. Saving an existing API key account without `apiKey` keeps its key. */
export const AccountDraft = z.object({
  id: AccountId.optional(),
  provider: ListedProviderKind,
  label: z.string().trim().min(1, "Add a name for this account.").max(MAX_ACCOUNT_LABEL),
  kind: AccountKind,
  apiKey: z.string().trim().min(1).max(4_000).optional(),
});
export type AccountDraft = z.infer<typeof AccountDraft>;

/** Handled directly by the runtime server; none of these reach the event log. */
export const AccountCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accounts.list") }),
  z.object({ type: z.literal("accounts.save"), account: AccountDraft }),
  z.object({ type: z.literal("accounts.delete"), accountId: AccountId }),
  /** Without accountId the provider goes back to the person's usual login. */
  z.object({ type: z.literal("accounts.setDefault"), provider: ListedProviderKind, accountId: AccountId.optional() }),
]);
export type AccountCommand = z.infer<typeof AccountCommand>;
export const ACCOUNT_COMMAND_TYPES = [
  "accounts.list",
  "accounts.save",
  "accounts.delete",
  "accounts.setDefault",
] as const;

export const AccountListResult = z.object({
  accounts: z.array(Account),
  /** Set when the saved accounts could not be read. */
  problem: z.string().optional(),
});
export type AccountListResult = z.infer<typeof AccountListResult>;
