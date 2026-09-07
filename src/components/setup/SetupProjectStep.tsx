import type { ProjectInfo } from "../../types";
import { IconFolder } from "../AppIcons";

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
    <section aria-labelledby="project-title">
      <h2 id="project-title" className="text-[17px] font-semibold">
        Choose a project
      </h2>
      <p className="mt-2 text-mute">
        Open the local Git repository your agents will work in.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          className={`btn ${props.project ? "btn-quiet" : "btn-primary"} min-h-10`}
          disabled={props.loading}
          onClick={props.onChoose}
        >
          <IconFolder />
          {props.loading ? "Opening project…" : "Choose project folder"}
        </button>
        <button
          className="btn btn-ghost min-h-10"
          disabled={props.loading}
          onClick={props.onManual}
        >
          Enter path manually
        </button>
      </div>
      {props.manual && (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onOpenPath();
          }}
        >
          <label className="min-w-0 flex-1">
            Repository path
            <input
              className="field mt-1 font-mono"
              value={props.path}
              onChange={(event) => props.onPath(event.target.value)}
              disabled={props.loading}
              autoFocus
            />
          </label>
          <button
            className="btn btn-quiet self-end min-h-8"
            disabled={props.loading || !props.path.trim()}
          >
            Open path
          </button>
        </form>
      )}
      {props.error && (
        <p role="alert" className="mt-3 text-danger">
          {props.error}
        </p>
      )}
      {props.project && (
        <div className="mt-5 rounded-xl border border-line bg-raised p-4">
          <p className="font-medium">{props.project.name}</p>
          <p className="mt-1 break-all font-mono text-xs text-mute">
            {props.project.path}
          </p>
          <p className="mt-2 text-mute">
            {props.project.currentBranch} ·{" "}
            {props.project.clean ? "Clean" : "Uncommitted changes"}
          </p>
        </div>
      )}
      {props.project && (
        <div className="mt-6 flex justify-end">
          <button
            className="btn btn-primary min-h-10"
            disabled={props.loading}
            onClick={props.onContinue}
          >
            Continue
          </button>
        </div>
      )}
    </section>
  );
}
