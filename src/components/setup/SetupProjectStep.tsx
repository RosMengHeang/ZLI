import type { ProjectInfo } from "../../types";
import { IconArrowRight, IconFolder, IconGit } from "../AppIcons";

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
  onContinue: () => void;
}

export function SetupProjectStep(props: Props) {
  return (
    <section aria-labelledby="project-title" className="setup-project-step">
      <div className="setup-project-mark">
        <IconGit />
      </div>
      <p className="setup-eyebrow">Local Git repository</p>
      <h2 id="project-title" className="setup-section-title mt-2">
        Start with the project you want to build
      </h2>
      <p className="setup-section-copy mt-2 max-w-xl">
        Taxzy keeps every agent focused on the same codebase while giving each
        one its own clear workspace.
      </p>

      <div className="setup-project-actions">
        <button
          type="button"
          className="btn btn-primary min-h-11 px-5"
          disabled={props.loading}
          onClick={props.onChoose}
        >
          <IconFolder />
          {props.loading ? "Opening project…" : "Choose repository folder"}
          {!props.loading ? <IconArrowRight /> : null}
        </button>
        <button
          type="button"
          className="btn btn-ghost min-h-11"
          disabled={props.loading}
          onClick={props.onManual}
        >
          Enter path manually
        </button>
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
            <input
              className="field mt-1 font-mono"
              value={props.path}
              onChange={(event) => props.onPath(event.target.value)}
              disabled={props.loading}
              autoFocus
              placeholder="D:\\Projects\\my-app"
            />
          </label>
          <button
            type="submit"
            className="btn btn-quiet self-end min-h-8"
            disabled={props.loading || !props.path.trim()}
          >
            Open path
          </button>
        </form>
      )}

      {props.error && (
        <p role="alert" className="banner banner-error mt-4">
          {props.error}
        </p>
      )}

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
          <button
            type="button"
            className="btn btn-primary min-h-9 shrink-0"
            disabled={props.loading}
            onClick={props.onContinue}
          >
            Configure agents
            <IconArrowRight />
          </button>
        </div>
      )}
    </section>
  );
}
