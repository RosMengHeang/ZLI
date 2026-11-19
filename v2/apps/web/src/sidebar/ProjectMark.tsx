import type { ProjectProjection, RuntimeProjection } from "@zli-v2/contracts";

import { useProjectIcon } from "../projects/projectIcons.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { checkoutWorktree } from "../sessions/launch.js";
import { Icon } from "../ui/Icon.js";

/** A ready copy of the project to look for its icon in: its own folder first, else any ready worktree. */
function iconWorktree(projection: RuntimeProjection | undefined, project: ProjectProjection): string | undefined {
  if (!projection) return undefined;
  const own = checkoutWorktree(projection, project);
  if (own?.status === "ready") return own.worktreeId;
  return projection.worktrees.find((entry) => entry.projectId === project.projectId && entry.status === "ready")
    ?.worktreeId;
}

/**
 * The project's mark: its app's real icon when its files have one (a favicon, an app icon), else a folder. A dot
 * on its corner says an agent in it is working (blue) or needs the person (amber).
 */
export function ProjectMark({
  project,
  projection,
  size = 16,
  state = "idle",
}: {
  project: ProjectProjection;
  projection: RuntimeProjection | undefined;
  size?: number;
  state?: "idle" | "working" | "waiting";
}) {
  const { dispatch } = useRuntime();
  const icon = useProjectIcon(dispatch, project.projectId, iconWorktree(projection, project));
  return (
    <span className={`project-mark is-${state}`} style={{ width: size, height: size }} aria-hidden="true">
      {icon ? (
        <img className="project-mark-icon" src={icon} alt="" width={size} height={size} draggable={false} />
      ) : (
        <Icon name="folder" size={size} />
      )}
      {state === "idle" ? null : <span className="project-mark-dot" />}
    </span>
  );
}
