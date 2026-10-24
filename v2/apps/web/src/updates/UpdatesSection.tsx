import { useState } from "react";

import { SectionHeader } from "../settings/SectionHeader.js";
import { LaunchRow } from "../sessions/NewAgentDialog.js";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Switch } from "../ui/Switch.js";
import { lastCheckedText, updateStatusText } from "./updateCopy.js";
import type { Updates } from "./useUpdates.js";

export function UpdatesSection({ updates, onRestart }: { updates: Updates | undefined; onRestart(): void }) {
  const [checking, setChecking] = useState(false);
  const status = updates?.status;
  if (!updates?.available || !status) {
    return (
      <>
        <SectionHeader title="Updates" />
        <p className="settings-empty">Updates are only available in the ZLI desktop app.</p>
      </>
    );
  }
  const { state } = status;
  const disabled = status.disabledReason !== undefined;
  const busy = state.status === "downloading" || state.status === "ready";
  const check = async () => {
    setChecking(true);
    try {
      await updates.check();
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <SectionHeader title="Updates">
        ZLI looks for a new version on GitHub when it starts and every 4 hours.
      </SectionHeader>
      <div className="launch-rows">
        <LaunchRow label="Version">
          <span className="settings-value is-mono">{status.currentVersion}</span>
        </LaunchRow>
        <LaunchRow label="Channel" hint="Only stable releases are offered for now.">
          <Select className="input-sm" aria-label="Update channel" value={status.channel} disabled>
            <option value="stable">Stable</option>
          </Select>
        </LaunchRow>
      </div>
      <div className="update-status">
        <p className="update-status-text" role="status">
          {updateStatusText(status)}
        </p>
        {state.status === "downloading" ? (
          <progress className="update-progress" max={100} value={state.percent} aria-label="Download progress" />
        ) : null}
        <p className="update-checked">{lastCheckedText(status.lastCheckedAt)}</p>
        <div className="update-actions">
          <Button
            size="sm"
            icon="reload"
            loading={checking || state.status === "checking"}
            disabled={disabled || busy}
            onClick={() => void check()}
          >
            Check for updates
          </Button>
          {state.status === "available" && state.canAutoInstall ? (
            <Button size="sm" variant="primary" icon="download" onClick={() => void updates.download()}>
              Download and install
            </Button>
          ) : null}
          {state.status === "available" && !state.canAutoInstall ? (
            <Button size="sm" variant="primary" icon="externalLink" onClick={() => void updates.openReleasePage()}>
              Open the release page
            </Button>
          ) : null}
          {state.status === "ready" ? (
            <Button size="sm" variant="primary" icon="rotate" onClick={onRestart}>
              Restart to update
            </Button>
          ) : null}
        </div>
      </div>
      <div className="settings-switches">
        <Switch
          label="Install updates automatically"
          hint="Downloads new versions in the background and installs them when ZLI restarts. On macOS, ZLI links to the download instead for now."
          checked={status.autoInstall}
          disabled={disabled}
          onChange={(autoInstall) => void updates.setAutoInstall(autoInstall)}
        />
      </div>
    </>
  );
}
