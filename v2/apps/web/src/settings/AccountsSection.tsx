import {
  type Account,
  type AccountKind,
  accountKinds,
  ListedProviderKind,
  type ProviderDiscovery,
  type RuntimeProjection,
  USUAL_LOGIN_ACCOUNT_ID,
} from "@zli-v2/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  accountKindLabel,
  accountNote,
  accountsFor,
  supportsAccounts,
  USUAL_LOGIN_LABEL,
  useAccounts,
  validateDraft,
} from "../accounts/accounts.js";
import { type AgentStatus, agentStatus, statusLine } from "../agent/agentStatus.js";
import { listedDiscoveries, providerDisplayName, signInCommand } from "../agent/providers.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { installCommand, installPlatform } from "../welcome/welcome.js";
import { discoverProviders } from "../welcome/welcomeClient.js";
import { SettingsGroup, SettingsPageHeader } from "./SettingsLayout.js";

type Check = { status: "idle" } | { status: "checking" } | { status: "error"; message: string };

/** Coming back to the window after signing in elsewhere checks again, but not more often than this. */
const FOCUS_CHECK_MS = 15_000;

/**
 * Asks the runtime to look at every agent again, on open, on Re-check, and when the window gets focus back
 * (the usual moment after signing in from a terminal). `clearProblem` forgets an agent's failed run first.
 */
function useAgentCheck() {
  const { dispatch } = useRuntime();
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const [fresh, setFresh] = useState<ProviderDiscovery[]>();
  const last = useRef(0);
  const run = useCallback(
    async (clearProblem?: ListedProviderKind) => {
      last.current = Date.now();
      setCheck({ status: "checking" });
      const result = await discoverProviders(dispatch, clearProblem);
      if (result.ok) {
        setFresh(result.value);
        setCheck({ status: "idle" });
      } else setCheck({ status: "error", message: result.error });
    },
    [dispatch],
  );
  useEffect(() => {
    void run();
    const onFocus = () => {
      if (Date.now() - last.current >= FOCUS_CHECK_MS) void run();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [run]);
  return { check, fresh, run };
}

type Editing = { provider: ListedProviderKind; id?: string; label: string; kind: AccountKind; apiKey: string };

/**
 * The agents that get a group of their own: installed ones, and any with saved accounts, in the order the
 * New agent dialog shows them. The rest are listed together as not installed.
 */
function shownProviders(
  providers: readonly ProviderDiscovery[] | undefined,
  accounts: readonly Account[],
): ListedProviderKind[] {
  const found = new Set(
    listedDiscoveries(providers).flatMap((entry) => (entry.status === "found" ? [entry.provider] : [])),
  );
  return ListedProviderKind.options.filter(
    (provider) => found.has(provider) || (supportsAccounts(provider) && accountsFor(accounts, provider).length > 0),
  );
}

export function AccountsSection({
  projection,
  onSignIn,
}: {
  projection: RuntimeProjection | undefined;
  onSignIn?(account: Account): Promise<string | undefined>;
}) {
  const { state, accounts, reload, save, remove, setDefault } = useAccounts();
  const { check, fresh, run: recheck } = useAgentCheck();
  // The projection follows every change the runtime announces; the check's own answer covers the moment before.
  const discovered = projection?.providers ?? fresh;
  const [editing, setEditing] = useState<Editing>();
  const [problem, setProblem] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const labelRef = useRef<HTMLInputElement>(null);
  const providers = useMemo(() => shownProviders(discovered, accounts), [discovered, accounts]);
  const missing = listedDiscoveries(discovered).filter(
    (entry) => entry.status === "missing" && !providers.includes(entry.provider),
  );
  const unsupported = ListedProviderKind.options
    .filter((provider) => !supportsAccounts(provider))
    .map((provider) => providerDisplayName(provider, discovered));
  const platform = installPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const checking = check.status === "checking";

  const header = (
    <SettingsPageHeader title="Accounts">
      Who each agent is signed in as on this computer, and what it pays with. An agent can also run under another login
      or API key you add here.
    </SettingsPageHeader>
  );

  const checkLine =
    check.status === "error" ? (
      <div className="accounts-check">
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {check.message} What is shown below may be out of date.
        </p>
        <Button size="sm" onClick={() => void recheck()}>
          Try again
        </Button>
      </div>
    ) : (
      <div className="accounts-check">
        {checking ? (
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Checking each agent's sign-in
          </p>
        ) : (
          <p className="settings-footnote">
            Read from each agent's own files on this computer. A plan shows when the agent records it.
          </p>
        )}
        <Button size="sm" variant="ghost" icon="reload" disabled={checking} onClick={() => void recheck()}>
          Re-check
        </Button>
      </div>
    );

  if (!discovered) {
    return (
      <>
        {header}
        {check.status === "error" ? (
          checkLine
        ) : (
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Checking each agent's sign-in
          </p>
        )}
      </>
    );
  }

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      await work();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (provider: ListedProviderKind, account?: Account) => {
    setConfirmDelete(undefined);
    setProblem(undefined);
    setError(undefined);
    const kinds = accountKinds(provider);
    flushSync(() =>
      setEditing(
        account
          ? { provider, id: account.id, label: account.label, kind: account.kind, apiKey: "" }
          : { provider, label: "", kind: kinds[0] ?? "api-key", apiKey: "" },
      ),
    );
    labelRef.current?.focus();
  };

  const submit = async () => {
    if (!editing) return;
    const invalid = validateDraft(editing, editing.id === undefined);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setProblem(undefined);
    const apiKey = editing.kind === "api-key" ? editing.apiKey.trim() : "";
    const saved = await run(() =>
      save({
        provider: editing.provider,
        label: editing.label.trim(),
        kind: editing.kind,
        ...(editing.id ? { id: editing.id } : {}),
        ...(apiKey ? { apiKey } : {}),
      }),
    );
    if (saved) setEditing(undefined);
  };

  const signIn = async (account: Account) => {
    if (!onSignIn) return;
    setError(undefined);
    const failure = await onSignIn(account);
    if (failure) setError(failure);
    else void recheck();
  };

  const setDraft = (patch: Partial<Editing>) => setEditing((current) => (current ? { ...current, ...patch } : current));
  const editingAccount = editing?.id ? accounts.find((account) => account.id === editing.id) : undefined;

  const editor = (provider: ListedProviderKind) => {
    if (editing?.provider !== provider) return null;
    const kinds = accountKinds(provider);
    const name = providerDisplayName(provider, projection?.providers);
    return (
      <form
        className="mcp-editor"
        aria-label={editing.id ? `Edit ${name} account` : `New ${name} account`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" hint="Shown on the agent's tile, so you can tell accounts apart.">
          <input
            ref={labelRef}
            className="input input-sm"
            value={editing.label}
            maxLength={60}
            placeholder="Work"
            onChange={(event) => setDraft({ label: event.target.value })}
          />
        </Field>
        {kinds.length > 1 && !editing.id ? (
          <Field label="Kind">
            <Select<AccountKind>
              className="input-sm"
              label="Kind"
              value={editing.kind}
              options={kinds.map((kind) => ({ value: kind, label: accountKindLabel[kind] }))}
              onChange={(kind) => setDraft({ kind })}
            />
          </Field>
        ) : null}
        {editing.kind === "api-key" ? (
          <Field
            label="API key"
            hint={
              editingAccount?.keyHint
                ? `Leave empty to keep the key ending ${editingAccount.keyHint.replace("…", "")}.`
                : "Stays on this computer, in a file only you can read."
            }
          >
            <input
              className="input input-sm is-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={editing.apiKey}
              onChange={(event) => setDraft({ apiKey: event.target.value })}
            />
          </Field>
        ) : (
          <p className="settings-footnote">After you save, choose Sign in to log in with this account.</p>
        )}
        {problem || error ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {problem ?? error}
          </p>
        ) : null}
        <div className="mcp-editor-actions">
          <Button
            size="sm"
            onClick={() => {
              setEditing(undefined);
              setProblem(undefined);
              setError(undefined);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" loading={saving}>
            {editing.id ? "Save changes" : "Add account"}
          </Button>
        </div>
      </form>
    );
  };

  const accountsReady = state.status === "ready";
  return (
    <>
      {header}
      {checkLine}
      {state.status === "loading" ? (
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading the accounts you added
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="accounts-check">
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {state.message}
          </p>
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.status === "ready" && state.result.problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {state.result.problem} Saving starts a new list.
        </p>
      ) : null}
      {providers.length === 0 ? (
        <p className="settings-empty">
          No coding agent is installed on this computer yet. Install one from the list below, then choose Re-check.
        </p>
      ) : null}
      {providers.map((provider) => {
        const name = providerDisplayName(provider, discovered);
        const own = accountsFor(accounts, provider);
        const usualIsDefault = !own.some((account) => account.default);
        const canAdd = accountsReady && supportsAccounts(provider);
        const status = agentStatus(discovered.find((entry) => entry.provider === provider));
        return (
          <SettingsGroup
            key={provider}
            label={`${name} accounts`}
            title={
              <span className="settings-group-title-mark">
                <ProviderMark provider={provider} size={14} />
                {name}
              </span>
            }
            actions={
              !canAdd || editor(provider) ? undefined : (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="plus"
                  disabled={saving}
                  aria-label={`Add ${name} account`}
                  onClick={() => startEdit(provider)}
                >
                  Add account
                </Button>
              )
            }
            bare
          >
            <ul className="mcp-rows">
              <li className={`mcp-row accounts-usual is-${status.kind}`}>
                <span className="mcp-row-copy">
                  <strong>{USUAL_LOGIN_LABEL}</strong>
                  <span className="accounts-status">{statusLine(status)}</span>
                  <span className="mcp-row-detail">{statusDetail(status, name, provider)}</span>
                </span>
                <UsualActions
                  status={status}
                  name={name}
                  provider={provider}
                  checking={checking}
                  onCheck={(clearProblem) => void recheck(clearProblem ? provider : undefined)}
                />
                {!canAdd ? null : usualIsDefault ? (
                  own.length > 0 ? (
                    <Badge tone="quiet">Default</Badge>
                  ) : null
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={saving}
                    aria-label={`Use ${USUAL_LOGIN_LABEL} for ${name} by default`}
                    onClick={() => void run(() => setDefault(provider, USUAL_LOGIN_ACCOUNT_ID))}
                  >
                    Set default
                  </Button>
                )}
              </li>
              {own.map((account) => (
                <li className="mcp-row" key={account.id}>
                  <span className="mcp-row-copy">
                    <strong>{account.label}</strong>
                    <span className="mcp-row-detail">
                      {account.kind === "api-key"
                        ? `API key ${account.keyHint ?? ""}`.trim()
                        : account.status === "signed-in"
                          ? "Signed in"
                          : "Not checked"}
                      {accountNote(account) ? `. ${accountNote(account)}` : ""}
                    </span>
                  </span>
                  {confirmDelete === account.id ? (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="is-danger"
                        disabled={saving}
                        onClick={async () => {
                          if (await run(() => remove(account.id))) {
                            setConfirmDelete(undefined);
                            if (editing?.id === account.id) setEditing(undefined);
                          }
                        }}
                      >
                        Delete
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(undefined)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <>
                      {account.kind === "sign-in" && onSignIn ? (
                        <Button
                          size="xs"
                          disabled={saving}
                          aria-label={`Sign in to ${account.label}`}
                          onClick={() => void signIn(account)}
                        >
                          Sign in
                        </Button>
                      ) : null}
                      {account.default ? (
                        <Badge tone="quiet">Default</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={saving}
                          aria-label={`Use ${account.label} for ${name} by default`}
                          onClick={() => void run(() => setDefault(provider, account.id))}
                        >
                          Set default
                        </Button>
                      )}
                      <IconButton
                        label={`Edit ${account.label}`}
                        icon="pencil"
                        size="xs"
                        iconSize={12}
                        disabled={saving}
                        onClick={() => startEdit(provider, account)}
                      />
                      <IconButton
                        label={`Delete ${account.label}`}
                        icon="trash"
                        size="xs"
                        iconSize={12}
                        disabled={saving}
                        onClick={() => setConfirmDelete(account.id)}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
            {editor(provider)}
          </SettingsGroup>
        );
      })}
      {missing.length > 0 ? (
        <SettingsGroup title="Not installed" label="Agents not installed" bare>
          <ul className="mcp-rows">
            {missing.map((entry) => {
              const command = installCommand(entry.provider, platform);
              return (
                <li className="mcp-row accounts-usual is-missing" key={entry.provider}>
                  <ProviderMark provider={entry.provider} size={14} />
                  <span className="mcp-row-copy">
                    <strong>{entry.displayName}</strong>
                    <span className="mcp-row-detail">
                      {command ? (
                        <>
                          Install with <code>{command}</code>, then choose Re-check.
                        </>
                      ) : entry.status === "missing" ? (
                        entry.reason
                      ) : null}
                    </span>
                  </span>
                  {command ? (
                    <CopyCommand label={`Copy the install command for ${entry.displayName}`} command={command} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SettingsGroup>
      ) : null}
      {error && !editing ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {error}
        </p>
      ) : null}
      <p className="settings-footnote">
        Agents keep the account they started with. {unsupported.join(" and ")} do not support accounts yet.
      </p>
    </>
  );
}

/** What the agent's status means for the person, in a sentence, with the agent's own words when it gave some. */
function statusDetail(status: AgentStatus, name: string, provider: ListedProviderKind): ReactNode {
  const command = signInCommand(provider);
  const signInHint = command ? (
    <>
      Run <code>{command}</code> in a terminal to sign in, then choose Check again.
    </>
  ) : (
    `Sign in from ${name}'s own CLI, then choose Check again.`
  );
  switch (status.kind) {
    case "checking":
      return "ZLI is reading this agent's sign-in.";
    case "missing":
      return `${name} is no longer found on this computer. Accounts you added stay saved.`;
    case "signed-out":
      return status.problem ? (
        <>
          Its last run said: “{status.problem.message}” {signInHint}
        </>
      ) : (
        <>
          {name} cannot run until it is signed in. {signInHint}
        </>
      );
    case "no-plan":
      return (
        <>
          Its last run said: “{status.problem.message}” Add a plan or credits to this account, or sign in with another,
          then choose Try again.
        </>
      );
    case "subscription":
      return status.plan
        ? `Plan read from ${name}'s sign-in on this computer.`
        : `${name} does not record the plan name where ZLI can read it. It still runs; a run that needs a plan will say so here.`;
    case "api-key":
      return "Billed to the key's API account. ZLI does not read or show the key.";
    case "unknown":
      return `${name} keeps its sign-in where ZLI cannot read it, such as the system keychain. It may still run; a failed run will say so here.`;
  }
}

/** The next step for the usual login: copy the sign-in command, check again, or clear a failed run. */
function UsualActions({
  status,
  name,
  provider,
  checking,
  onCheck,
}: {
  status: AgentStatus;
  name: string;
  provider: ListedProviderKind;
  checking: boolean;
  onCheck(clearProblem: boolean): void;
}) {
  if (status.kind === "checking" || status.kind === "subscription" || status.kind === "api-key") return null;
  const command = status.kind === "signed-out" ? signInCommand(provider) : undefined;
  const problem = status.kind === "signed-out" || status.kind === "no-plan" ? status.problem : undefined;
  const retry = status.kind === "no-plan";
  return (
    <>
      {command ? <CopyCommand label={`Copy the sign-in command for ${name}`} command={command} /> : null}
      <Button
        size="xs"
        disabled={checking}
        aria-label={`${retry ? "Try again with" : "Check again for"} ${name}`}
        onClick={() => onCheck(problem !== undefined)}
      >
        {retry ? "Try again" : "Check again"}
      </Button>
    </>
  );
}

function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={label}
      tooltip={copied ? "Copied" : "Copy command"}
      icon={copied ? "check" : "copy"}
      size="xs"
      iconSize={12}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    />
  );
}
