import type { LinearStatusResult } from "@zli-v2/contracts";
import { useEffect, useId, useState } from "react";

import { connectLinear, disconnectLinear, linearStatus } from "../issues/issuesClient.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { ConnectorLogo } from "./connectorLogos.js";
import { SettingsGroup } from "./SettingsLayout.js";
import "../issues/issues.css";

/**
 * The Issues group on the Forges page. GitHub and GitLab issues come through gh and glab, listed above it, so
 * the only tracker set up here is Linear, which needs its own API key.
 */
export function IssuesGroup() {
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

  const connected = status?.connected === true;
  const problem = loadError ?? error ?? (connected ? status?.problem : undefined);
  const state = !status ? "checking" : connected ? (status.problem ? "signed_out" : "ready") : "missing";
  const detail = !status
    ? "Checking Linear."
    : connected
      ? `Connected as ${status.viewer?.name ?? "your Linear account"}.`
      : "Paste an API key from Linear, under Settings, Security and access. It stays on this computer.";

  return (
    <SettingsGroup
      title="Issues"
      description="GitHub and GitLab issues come from gh and glab above. Linear needs its own key."
      bare
    >
      <ul className="forge-list" aria-label="Issue trackers">
        <li className={`forge-row is-${state}`}>
          <ConnectorLogo id="linear" title="Linear" size={28} />
          <div className="forge-copy">
            <div className="forge-title">
              <span className="forge-name">Linear</span>
            </div>
            <p className="forge-detail">{detail}</p>
            {problem ? (
              <p className="forge-detail is-error" role="alert">
                {problem}
              </p>
            ) : null}
            {status && !connected ? (
              <form
                className="setting-inline forge-key"
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
            ) : null}
          </div>
          <div className="forge-side">
            {!status && !loadError ? (
              <span className="spinner" aria-hidden="true" />
            ) : connected ? (
              <>
                <span className={`forge-state is-${state}`}>
                  <span className="forge-state-dot" aria-hidden="true" />
                  {status?.problem ? "Problem" : "Connected"}
                </span>
                <Button size="sm" loading={busy} onClick={() => void run(() => disconnectLinear(dispatch))}>
                  Disconnect
                </Button>
              </>
            ) : status ? (
              <span className="forge-state">
                <span className="forge-state-dot" aria-hidden="true" />
                Not connected
              </span>
            ) : (
              <Icon name="alert" size={14} />
            )}
          </div>
        </li>
      </ul>
    </SettingsGroup>
  );
}
