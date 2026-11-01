import { Button } from "../../ui/Button.js";
import { EmptyState } from "../../ui/Pane.js";
import { BuildGroup } from "./build/BuildGroup.js";
import type { MobileDevContext } from "./context.js";
import { DoctorGroup } from "./doctor/DoctorGroup.js";
import { PackagesGroup } from "./packages/PackagesGroup.js";
import { WorkspaceProjectGroup } from "./workspace/WorkspaceProjectGroup.js";
import "./dev.css";

/** The Project check view: one titled group per feature, about the current agent's worktree. */
export function MobileProjectView({ context, onClose }: { context: MobileDevContext; onClose?: () => void }) {
  if (!context.worktreeId)
    return (
      <EmptyState
        icon="smartphone"
        title="Open an agent or worktree first"
        detail="The project check looks at the folder the current agent works in."
      >
        {onClose ? (
          <Button size="sm" onClick={onClose}>
            Back to the device
          </Button>
        ) : null}
      </EmptyState>
    );
  return (
    <div className="mobile-scroll">
      <div className="mobile-setup mobile-project">
        {context.worktreeName ? (
          <p className="mobile-project-context">
            Checking <code>{context.worktreeName}</code>
          </p>
        ) : null}
        <WorkspaceProjectGroup context={context} />
        <DoctorGroup context={context} />
        <PackagesGroup context={context} />
        <BuildGroup context={context} />
      </div>
    </div>
  );
}
