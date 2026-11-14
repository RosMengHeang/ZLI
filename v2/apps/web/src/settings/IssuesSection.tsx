import type { LinearStatusResult } from "@zli-v2/contracts";
import { useEffect, useId, useState } from "react";

import { connectLinear, disconnectLinear, linearStatus } from "../issues/issuesClient.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { SettingsGroup, SettingsPageHeader, SettingsRow } from "./SettingsLayout.js";
import "../issues/issues.css";

export function IssuesSection() {
  const { dispatch } = useRuntime();
  const inputId = useId();
  const [status, setStatus] = useState<LinearStatusResult>();
  const [loadError, setLoadError] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    linearStatus(dispatch)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const run = async (work: () => Promise<LinearStatusResult>) => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await work());
      setApiKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsPageHeader title="Issues">Where ZLI finds the issues you can start agents from.</SettingsPageHeader>
      <SettingsGroup title="Linear">
        {loadError ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {loadError}
          </p>
        ) : !status ? (
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Checking Linear
          </p>
        ) : status.connected ? (
          <SettingsRow
            label="Linear"
            description={
              status.problem ? status.problem : `Connected as ${status.viewer?.name ?? "your Linear account"}.`
            }
            descriptionTone={status.problem ? "warning" : undefined}
          >
            <Button size="sm" loading={busy} onClick={() => void run(() => disconnectLinear(dispatch))}>
              Disconnect
            </Button>
          </SettingsRow>
        ) : (
          <SettingsRow
            label="Linear API key"
            htmlFor={inputId}
            description="Create one in Linear under Settings, Security and access. ZLI keeps it on this computer and only sends it to Linear."
          >
            <form
              className="setting-inline"
              onSubmit={(event) => {
                event.preventDefault();
                if (apiKey.trim()) void run(() => connectLinear(dispatch, apiKey.trim()));
              }}
            >
              <input
                id={inputId}
                className="input is-mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Linear API key"
                placeholder="lin_api_..."
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Button size="sm" variant="primary" type="submit" loading={busy} disabled={!apiKey.trim()}>
                Connect
              </Button>
            </form>
          </SettingsRow>
        )}
        {error ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </p>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="GitHub and GitLab">
        <SettingsRow
          label="GitHub"
          description="Read with the gh CLI in each project folder. Sign in with gh auth login."
        >
          <code className="settings-value is-mono">gh</code>
        </SettingsRow>
        <SettingsRow
          label="GitLab"
          description="Read with the glab CLI. For a self-hosted GitLab, sign in with glab auth login --hostname and its host name."
        >
          <code className="settings-value is-mono">glab</code>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
