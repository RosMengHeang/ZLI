import type { MobileWorkspace } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import type { MobileBridge } from "../../../runtime/bridge.js";
import { SettingsGroup, SettingsRow } from "../../../settings/SettingsLayout.js";
import { Badge } from "../../../ui/Badge.js";
import { LoadingState } from "../../../ui/Pane.js";
import { errorText } from "../../mobile.js";
import { folderName, ownerBadge } from "./useWorkspace.js";
import "./workspace.css";

/** Settings > Mobile: every worktree's Metro port and who listens on it. */
export function WorktreesSettingGroup({ mobile }: { mobile: MobileBridge }) {
  const api = mobile.dev?.workspace;
  const [list, setList] = useState<readonly MobileWorkspace[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setList(undefined);
    setError(undefined);
    if (!api) return;
    let current = true;
    // Reads overlap (change events and the first load), so only the newest one lands.
    let request = 0;
    const load = () => {
      const id = ++request;
      return api.list().then(
        (next) => {
          if (!current || id !== request) return;
          setList(next);
          setError(undefined);
        },
        (cause: unknown) => {
          if (current && id === request) setError(errorText(cause, "ZLI could not read the worktrees."));
        },
      );
    };
    void load();
    const unsubscribe = api.onChange(() => void load());
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api]);

  if (!api) return null;
  return (
    <SettingsGroup
      title="Worktrees"
      className="mobile-worktrees"
      description="Each worktree gets its own Metro port so agents never test another branch's app."
    >
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : list === undefined ? (
        <LoadingState label="Reading worktrees" />
      ) : list.length === 0 ? (
        <p className="settings-group-note">No worktrees yet.</p>
      ) : (
        list.map((workspace) => {
          const badge = ownerBadge(workspace.metro);
          return (
            <SettingsRow
              key={workspace.worktreeId}
              label={workspace.branch}
              description={
                workspace.path ? (
                  <span className="is-mono" title={workspace.path}>
                    {folderName(workspace.path)}
                  </span>
                ) : undefined
              }
            >
              <span className="mobile-workspace-value">
                <span className="settings-value is-mono">{workspace.metroPort}</span>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </span>
            </SettingsRow>
          );
        })
      )}
    </SettingsGroup>
  );
}
