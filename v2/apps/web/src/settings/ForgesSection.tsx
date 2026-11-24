import type { ForgeCliStatus, ForgeStatusResult } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { forgesStatus, rescanForges } from "../forges/forgesClient.js";
import { openExternalLink, useCopyFeedback } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { ConnectorLogo } from "./connectorLogos.js";
import { IssuesGroup } from "./IssuesSection.js";
import { SettingsGroup, SettingsPageHeader } from "./SettingsLayout.js";
import "../forges/forges.css";

const STATE_LABEL: Record<ForgeCliStatus["state"], string> = {
  ready: "Connected",
  signed_out: "Not signed in",
  missing: "Not installed",
  outdated: "Update needed",
  error: "Problem",
};

/** One line on what ZLI found, in the person's terms. */
function detail(forge: ForgeCliStatus): string {
  switch (forge.state) {
    case "ready": {
      const [first, ...rest] = forge.accounts;
      if (!first) return "Signed in.";
      const who = first.login ? `${first.login} on ${first.host}` : first.host;
      return rest.length > 0 ? `${who}, and ${rest.length} more` : who;
    }
    case "signed_out":
      return `${forge.cli} is installed but not signed in to any server.`;
    case "missing":
      return `Install ${forge.cli}, the ${forge.label} CLI, to open ${forge.kind === "gitlab" ? "merge" : "pull"} requests from ZLI.`;
    case "outdated":
      return `ZLI needs ${forge.cli} ${forge.minimumVersion} or newer.`;
    case "error":
      return forge.message ?? `${forge.cli} gave an answer ZLI could not read.`;
  }
}

function ForgeRow({ forge }: { forge: ForgeCliStatus }) {
  const { bridge } = useRuntime();
  const [copyState, copy] = useCopyFeedback();
  const [linkError, setLinkError] = useState<string>();
  const needsInstall = forge.state === "missing" || forge.state === "outdated";
  const needsSignIn = forge.state === "signed_out";
  return (
    <li className={`forge-row is-${forge.state}`}>
      <ConnectorLogo id={forge.kind} title={forge.label} size={28} />
      <div className="forge-copy">
        <div className="forge-title">
          <span className="forge-name">{forge.label}</span>
          {forge.version ? (
            <span className="forge-version">
              {forge.cli} {forge.version}
            </span>
          ) : null}
        </div>
        <p className="forge-detail">{detail(forge)}</p>
        {linkError ? (
          <p className="forge-detail is-error" role="alert">
            {linkError}
          </p>
        ) : null}
      </div>
      <div className="forge-side">
        <span className={`forge-state is-${forge.state}`}>
          <span className="forge-state-dot" aria-hidden="true" />
          {STATE_LABEL[forge.state]}
        </span>
        {needsSignIn ? (
          <Button
            size="sm"
            icon={copyState === "copied" ? "check" : "copy"}
            tooltip={`Copy ${forge.signInCommand}, then run it in a terminal`}
            onClick={() => copy(forge.signInCommand)}
          >
            {copyState === "copied" ? "Copied" : forge.signInCommand}
          </Button>
        ) : null}
        {needsInstall ? (
          <Button
            size="sm"
            icon="globe"
            onClick={() => void openExternalLink(bridge, forge.installUrl).then(setLinkError)}
          >
            {forge.state === "outdated" ? "Update" : "Install"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Settings → Forges: each forge's CLI, whether it is installed and signed in, and how to fix it when not, then the
 * issue trackers agents can start from.
 */
export function ForgesSection() {
  const { dispatch } = useRuntime();
  const [status, setStatus] = useState<ForgeStatusResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    forgesStatus(dispatch)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const rescan = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await rescanForges(dispatch));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsPageHeader title="Forges">
        Where your repositories and issues live. ZLI drives each forge through its own CLI, signed in with your account,
        and picks the right one from a project's Git remote.
      </SettingsPageHeader>
      <SettingsGroup
        title="Command-line tools"
        bare
        actions={
          <Button size="sm" variant="ghost" icon="reload" loading={busy} onClick={() => void rescan()}>
            Rescan
          </Button>
        }
      >
        {error ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </p>
        ) : null}
        {status ? (
          <ul className="forge-list" aria-label="Forges">
            {status.forges.map((forge) => (
              <ForgeRow key={forge.kind} forge={forge} />
            ))}
          </ul>
        ) : error ? null : (
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Checking gh, glab and tea
          </p>
        )}
      </SettingsGroup>
      <p className="forge-footnote">
        Gitea covers Forgejo and Codeberg too. Self-hosted servers work once their CLI is signed in to them.
      </p>
      <IssuesGroup />
    </>
  );
}
