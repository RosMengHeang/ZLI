import type { ProjectInfo } from "../../types";
import { providerDisplayName } from "../../types";
import { ProviderIcon } from "../ProviderIcon";
import type { LaunchProgress } from "./setupModel";
import { Button } from "../ui/button";

interface Props {
  project: ProjectInfo | null;
  items: LaunchProgress[];
  busy: boolean;
  attempted: boolean;
  scanning: boolean;
  unavailable: string[];
  detectionError?: string;
  onRescan: () => void;
  onBack: () => void;
  onStart: () => void;
  onFinish: () => void;
}

export function SetupReviewStep(props: Props) {
  const failed = props.items.some((item) => item.status === "failed");
  return (
    <section aria-labelledby="review-title" aria-busy={props.busy}>
      <h2 id="review-title" className="text-[17px] font-semibold">
        Review your workspace
      </h2>
      <p className="mt-3 font-medium">{props.project?.name}</p>
      <p className="mt-1 break-all font-mono text-xs text-mute">
        {props.project?.path}
      </p>
      {(props.unavailable.length > 0 || props.detectionError) && (
        <div className="mt-4 rounded-xl border border-line p-3">
          {props.unavailable.length > 0 && (
            <p className="text-warn">
              Unavailable: {props.unavailable.join(", ")}. Install these CLIs
              and make them available on PATH, then rescan.
            </p>
          )}
          {props.detectionError && (
            <p role="alert" className="text-danger">
              {props.detectionError}
            </p>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            disabled={props.scanning || props.busy}
            onClick={props.onRescan}
          >
            {props.scanning ? "Scanning…" : "Rescan"}
          </Button>
        </div>
      )}
      <ol
        className="mt-5 divide-y divide-line"
        aria-live="polite"
        aria-label="Agent launch progress"
      >
        {props.items.map((item, index) => (
          <li key={index} className="py-3">
            <div className="flex items-center gap-2">
              <ProviderIcon provider={item.provider} size="sm" />
              <span className="min-w-0 flex-1 break-words font-medium">
                {item.name}
              </span>
              <span
                className={
                  item.status === "failed"
                    ? "text-danger"
                    : item.status === "running"
                      ? "text-ok"
                      : "text-mute"
                }
              >
                {item.status[0].toUpperCase() + item.status.slice(1)}
              </span>
            </div>
            <p className="mt-1 text-xs text-mute">
              {providerDisplayName(item.provider)} ·{" "}
              {item.useWorktree ? "Isolated worktree" : "Shared project folder"}
            </p>
            {item.error && (
              <p className="mt-1 break-words text-xs text-danger">
                {item.error}
              </p>
            )}
          </li>
        ))}
      </ol>
      {!props.items.length && (
        <p className="mt-4 text-mute">
          Open the workspace without agents. You can add them later.
        </p>
      )}
      {failed && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-mute">Successful launches are retained. Retry starts only failed agents.</p>
          <Button type="button" variant="secondary" size="sm" disabled={props.busy} onClick={props.onBack}>Edit failed agents</Button>
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        {!props.attempted ? (
          <Button
            variant="ghost"
            disabled={props.busy}
            onClick={props.onBack}
          >
            Back
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={props.busy}
            onClick={props.onFinish}
          >
            Open workspace
          </Button>
        )}
        <Button
          className="min-h-10"
          disabled={
            props.busy ||
            props.scanning ||
            props.unavailable.length > 0 ||
            !props.project
          }
          onClick={props.onStart}
        >
          {props.busy
            ? "Starting agents…"
            : failed
              ? "Retry failed agents"
              : props.items.length
                ? "Start agents"
                : "Open workspace"}
        </Button>
      </div>
    </section>
  );
}
