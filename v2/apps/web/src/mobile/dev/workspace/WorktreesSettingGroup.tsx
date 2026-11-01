import type { MobileWorkspace } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import type { MobileBridge } from "../../../runtime/bridge.js";
import { SettingGroup } from "../../../settings/SectionHeader.js";
import { Badge } from "../../../ui/Badge.js";
import { folderName, ownerBadge } from "./useWorkspace.js";
import "./workspace.css";

/** Settings > Mobile: every worktree's Metro port and who listens on it. */
export function WorktreesSettingGroup({ mobile }: { mobile: MobileBridge }) {
  const api = mobile.dev?.workspace;
  const [list, setList] = useState<readonly MobileWorkspace[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!api) return;
    let current = true;
    const load = () =>
      api.list().then(
        (next) => {
          if (!current) return;
          setList(next);
          setError(undefined);
        },
        (cause: unknown) => {
          if (current) setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    void load();
    const unsubscribe = api.onChange(() => void load());
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api]);

  if (!api) return null;
  return (
    <SettingGroup
      title="Worktrees"
      description="Each worktree gets its own Metro port so agents never test another branch's app."
    >
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : list?.length === 0 ? (
        <p className="settings-group-note">No worktrees yet.</p>
      ) : (
        list?.map((workspace) => {
          const badge = ownerBadge(workspace.metro);
          return (
            <div key={workspace.worktreeId} className="setting-row mobile-worktree-row">
              <div className="setting-copy">
                <span className="setting-label is-mono">{workspace.branch}</span>
                <p className="setting-description" title={workspace.path}>
                  {folderName(workspace.path)}
                </p>
              </div>
              <div className="setting-control mobile-workspace-value">
                <span className="settings-value is-mono">{workspace.metroPort}</span>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </div>
            </div>
          );
        })
      )}
    </SettingGroup>
  );
}
