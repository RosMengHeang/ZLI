import type { ProjectInfo } from "../../types";
import { IconArrowRight, IconFolder } from "../AppIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspaceStore } from "../../stores/workspaceStore";

interface Props {
  project: ProjectInfo | null;
  loading: boolean;
  error?: string;
  path: string;
  manual: boolean;
  onPath: (path: string) => void;
  onManual: () => void;
  onChoose: () => void;
  onOpenPath: () => void;
  onOpenRecent: (path: string) => void;
  onContinue: () => void;
}

export function SetupProjectStep(props: Props) {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const recent = workspaces.slice(0, 5);
  return (
    <section aria-labelledby="project-title" className="setup-project-step">
      <h1 id="project-title" className="setup-section-title">
        Choose a repository
      </h1>
      <p className="setup-section-copy mt-2">
        Select the local Git project your agents will work in.
      </p>

      <div className="setup-project-actions">
        <Button
          type="button"
          className="min-h-9 px-4"
          disabled={props.loading}
          onClick={props.onChoose}
        >
          <IconFolder />
          {props.loading ? "Opening project…" : "Choose repository folder"}
          {!props.loading ? <IconArrowRight /> : null}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-9"
          disabled={props.loading}
          onClick={props.onManual}
        >
          Enter path manually
        </Button>
      </div>

      {props.manual && (
        <form
          className="setup-path-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onOpenPath();
          }}
        >
          <label className="min-w-0 flex-1 text-xs text-mute">
            Repository path
            <Input
              className="mt-1 font-mono"
              value={props.path}
              onChange={(event) => props.onPath(event.target.value)}
              disabled={props.loading}
              autoFocus
              placeholder="D:\\Projects\\my-app"
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            className="self-end min-h-8"
            disabled={props.loading || !props.path.trim()}
          >
            Open path
          </Button>
        </form>
      )}

      {props.error && (
        <p role="alert" className="banner banner-error mt-4">
          {props.error}
        </p>
      )}

      {!props.project && recent.length ? (
        <div className="setup-recent-projects">
          <p className="mb-2 text-[11px] font-medium text-mute">Recent</p>
          {recent.map((workspace) => (
            <Button
              key={workspace.root}
              type="button"
              variant="ghost"
              className="setup-recent-project"
              disabled={props.loading}
              onClick={() => props.onOpenRecent(workspace.project.path)}
            >
              <IconFolder />
              <span className="min-w-0 flex-1 truncate text-left">{workspace.project.name}</span>
              <span className="truncate font-mono text-[11px] text-mute">{workspace.project.currentBranch}</span>
            </Button>
          ))}
        </div>
      ) : null}

      {props.project && (
        <div className="setup-project-confirmation">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold">
              {props.project.name}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-mute">
              {props.project.path}
            </p>
            <p className="mt-2 text-xs text-mute">
              {props.project.currentBranch} ·{" "}
              <span className={props.project.clean ? "text-ok" : "text-warn"}>
                {props.project.clean ? "Clean working tree" : "Uncommitted changes"}
              </span>
            </p>
          </div>
          <Button
            type="button"
            className="min-h-9 shrink-0"
            disabled={props.loading}
            onClick={props.onContinue}
          >
            Configure agents
            <IconArrowRight />
          </Button>
        </div>
      )}
    </section>
  );
}
