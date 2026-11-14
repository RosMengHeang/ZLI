import { useId, useState } from "react";

import { SettingsGroup, SettingsPageHeader, SettingsRow } from "../settings/SettingsLayout.js";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Switch } from "../ui/Switch.js";
import { lastCheckedText, updateStatusText } from "./updateCopy.js";
import type { Updates } from "./useUpdates.js";

export function UpdatesSection({ updates, onRestart }: { updates: Updates | undefined; onRestart(): void }) {
  const [checking, setChecking] = useState(false);
  const channelId = useId();
  const status = updates?.status;
  if (!updates?.available || !status) {
    return (
      <>
        <SettingsPageHeader title="Updates" />
        <SettingsGroup title="This version" bare>
          <p className="settings-empty">Updates are only available in the ZLI desktop app.</p>
        </SettingsGroup>
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
      <SettingsPageHeader title="Updates">
        ZLI looks for a new version on GitHub when it starts and every 4 hours.
      </SettingsPageHeader>
      <SettingsGroup title="This version">
        <div className="update-status">
          <div className="update-status-copy">
            <p className="update-status-text" role="status">
              {updateStatusText(status)}
            </p>
            <p className="update-checked">{lastCheckedText(status.lastCheckedAt)}</p>
          </div>
          <div className="update-actions">
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
            <Button
              size="sm"
              icon="reload"
              loading={checking || state.status === "checking"}
              disabled={disabled || busy}
              onClick={() => void check()}
            >
              Check for updates
            </Button>
          </div>
          {state.status === "downloading" ? (
            <progress className="update-progress" max={100} value={state.percent} aria-label="Download progress" />
          ) : null}
        </div>
        <SettingsRow label="Version" description="The version running now.">
          <span className="settings-value is-mono">{status.currentVersion}</span>
        </SettingsRow>
        <SettingsRow label="Channel" description="Only stable releases are offered for now." htmlFor={channelId}>
          <Select
            id={channelId}
            label="Update channel"
            value={status.channel}
            options={[{ value: "stable", label: "Stable" }]}
            onChange={() => undefined}
            disabled
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Installing">
        <Switch
          label="Install updates automatically"
          hint="Downloads new versions in the background and installs them when ZLI restarts."
          checked={status.autoInstall}
          disabled={disabled}
          onChange={(autoInstall) => void updates.setAutoInstall(autoInstall)}
        />
      </SettingsGroup>
    </>
  );
}
