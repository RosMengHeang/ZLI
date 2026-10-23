import { useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { EmptyState, LoadingState } from "../ui/Pane.js";
import { readFileData } from "./fileClient.js";
import { baseName } from "./filePaths.js";

type ImageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; size: number; width?: number; height?: number };

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shows an image file from the worktree, fitted to the panel or at its actual size. */
export function ImagePreview({ worktreeId, path, version }: { worktreeId: string; path: string; version: string }) {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<ImageState>({ status: "loading" });
  const [actualSize, setActualSize] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version on disk or a retry reloads the image.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    readFileData(dispatch, worktreeId, path).then(
      (data) => {
        if (!cancelled) {
          setState({ status: "ready", url: `data:${data.mimeType};base64,${data.dataBase64}`, size: data.size });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: cause instanceof Error ? cause.message : "The image could not be loaded.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dispatch, worktreeId, path, version, attempt]);

  if (state.status === "loading") return <LoadingState label={`Loading ${baseName(path)}`} />;
  if (state.status === "error") {
    return (
      <EmptyState icon="alert" tone="danger" title="The image could not be shown" detail={state.message}>
        <Button icon="reload" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </EmptyState>
    );
  }
  const dimensions = state.width && state.height ? `${state.width} × ${state.height} px · ` : "";
  return (
    <div className="file-image">
      <div className={`file-image-stage${actualSize ? " is-actual" : ""}`}>
        <img
          src={state.url}
          alt={baseName(path)}
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            setState((current) => (current.status === "ready" ? { ...current, width, height } : current));
          }}
          onError={() => setState({ status: "error", message: `ZLI could not decode ${baseName(path)}.` })}
        />
      </div>
      <div className="file-image-bar">
        <span className="file-image-meta">
          {dimensions}
          {formatFileSize(state.size)}
        </span>
        <Button variant="ghost" size="sm" aria-pressed={actualSize} onClick={() => setActualSize((value) => !value)}>
          {actualSize ? "Fit to panel" : "Actual size"}
        </Button>
      </div>
    </div>
  );
}
