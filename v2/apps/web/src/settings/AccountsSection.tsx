import {
  type Account,
  type AccountKind,
  accountKinds,
  ListedProviderKind,
  type RuntimeProjection,
  USUAL_LOGIN_ACCOUNT_ID,
} from "@zli-v2/contracts";
import { useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import {
  accountKindLabel,
  accountNote,
  accountsFor,
  supportsAccounts,
  USUAL_LOGIN_LABEL,
  useAccounts,
  validateDraft,
} from "../accounts/accounts.js";
import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { SectionHeader } from "./SectionHeader.js";

type Editing = { provider: ListedProviderKind; id?: string; label: string; kind: AccountKind; apiKey: string };

/** Agents ZLI can list, in the order the New agent dialog shows them. */
function shownProviders(projection: RuntimeProjection | undefined, accounts: readonly Account[]): ListedProviderKind[] {
  const found = new Set(
    (projection?.providers ?? []).filter((entry) => entry.status === "found").map((entry) => entry.provider),
  );
  return ListedProviderKind.options.filter(
    (provider) => supportsAccounts(provider) && (found.has(provider) || accountsFor(accounts, provider).length > 0),
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
  const [editing, setEditing] = useState<Editing>();
  const [problem, setProblem] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const labelRef = useRef<HTMLInputElement>(null);
  const providers = useMemo(() => shownProviders(projection, accounts), [projection, accounts]);
  const unsupported = ListedProviderKind.options
    .filter((provider) => !supportsAccounts(provider))
    .map((provider) => providerDisplayName(provider, projection?.providers));

  const header = (
    <SectionHeader title="Accounts">
      Run an agent under another login or API key. Usual login is the one the agent's CLI already uses on this computer.
    </SectionHeader>
  );

  if (state.status === "loading") {
    return (
      <>
        {header}
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading accounts
        </p>
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        {header}
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {state.message}
        </p>
        <div className="settings-actions">
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
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
    setEditing(
      account
        ? { provider, id: account.id, label: account.label, kind: account.kind, apiKey: "" }
        : { provider, label: "", kind: kinds[0] ?? "api-key", apiKey: "" },
    );
    requestAnimationFrame(() => labelRef.current?.focus());
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

  return (
    <>
      {header}
      {state.result.problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {state.result.problem} Saving starts a new list.
        </p>
      ) : null}
      {providers.length === 0 ? (
        <p className="settings-empty">None of the agents installed on this computer support accounts yet.</p>
      ) : null}
      {providers.map((provider) => {
        const name = providerDisplayName(provider, projection?.providers);
        const own = accountsFor(accounts, provider);
        const usualIsDefault = !own.some((account) => account.default);
        return (
          <section className="accounts-provider" key={provider} aria-label={`${name} accounts`}>
            <h3 className="mcp-subhead accounts-subhead">
              <ProviderMark provider={provider} size={14} />
              {name}
            </h3>
            <ul className="mcp-rows">
              <li className="mcp-row">
                <span className="mcp-row-copy">
                  <strong>{USUAL_LOGIN_LABEL}</strong>
                  <span className="mcp-row-detail">Your own {name} login and settings.</span>
                </span>
                {usualIsDefault ? (
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
            {editor(provider) ?? (
              <div className="settings-actions">
                <Button
                  size="sm"
                  icon="plus"
                  disabled={saving}
                  aria-label={`Add ${name} account`}
                  onClick={() => startEdit(provider)}
                >
                  Add account
                </Button>
              </div>
            )}
          </section>
        );
      })}
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
