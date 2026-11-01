import { Icon } from "../../../ui/Icon.js";
import type { MobileDevContext } from "../context.js";
import { ownerWarning, useWorkspace } from "./useWorkspace.js";

/** Warns when this worktree's Metro port is held by another worktree or another program. */
export function WorkspaceBanner({ context }: { context: MobileDevContext }) {
  const { workspace } = useWorkspace(context.mobile.dev?.workspace, context.worktreeId);
  const warning = workspace ? ownerWarning(workspace) : undefined;
  if (!warning) return null;
  return (
    <div className="banner banner-warning" role="status">
      <Icon name="alert" size={14} />
      <span className="banner-message">{warning}</span>
    </div>
  );
}
