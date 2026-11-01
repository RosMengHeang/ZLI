import { SettingGroup, SettingRow } from "../../../settings/SectionHeader.js";
import { Badge } from "../../../ui/Badge.js";
import { IconButton } from "../../../ui/Button.js";
import type { MobileDevContext } from "../context.js";
import { ownerBadge, useWorkspace } from "./useWorkspace.js";
import "./workspace.css";

/** The project view's "This worktree" group: its Metro port and owner, the URL to open, and its emulator port. */
export function WorkspaceProjectGroup({ context }: { context: MobileDevContext }) {
  const { workspace, error } = useWorkspace(context.mobile.dev?.workspace, context.worktreeId);
  if (!context.mobile.dev?.workspace) return null;
  if (!workspace)
    return error ? (
      <SettingGroup title="This worktree">
        <p className="inline-error" role="alert">
          {error}
        </p>
      </SettingGroup>
    ) : null;
  const badge = ownerBadge(workspace.metro);
  const copy = () => {
    if (!navigator.clipboard) return context.onError("ZLI could not copy the URL. Select it and copy it instead.");
    navigator.clipboard.writeText(workspace.openUrl).then(
      () => context.onNotice("Copied the URL."),
      () => context.onError("ZLI could not copy the URL. Select it and copy it instead."),
    );
  };
  return (
    <SettingGroup title="This worktree" className="mobile-workspace-group">
      <SettingRow
        label="Metro port"
        description={
          workspace.checkout
            ? "The project's own checkout keeps Metro's default port."
            : "Set as RCT_METRO_PORT in this worktree's terminals."
        }
      >
        <span className="mobile-workspace-value">
          <span className="settings-value is-mono">{workspace.metroPort}</span>
          <Badge tone={badge.tone} {...(workspace.metro.state === "unknown" ? { title: workspace.metro.reason } : {})}>
            {badge.label}
          </Badge>
        </span>
      </SettingRow>
      <SettingRow label="Open on a device" description={workspace.devClient ? "Development build" : "Expo Go"}>
        <span className="mobile-workspace-value">
          <span className="settings-value is-mono mobile-workspace-url" title={workspace.openUrl}>
            {workspace.openUrl}
          </span>
          <IconButton label="Copy URL" icon="copy" size="xs" iconSize={12} onClick={copy} />
        </span>
      </SettingRow>
      <SettingRow label="Emulator port">
        {workspace.emulatorPort !== undefined ? (
          <span className="settings-value is-mono">emulator-{workspace.emulatorPort}</span>
        ) : (
          <span className="settings-value">Any free port</span>
        )}
      </SettingRow>
    </SettingGroup>
  );
}
