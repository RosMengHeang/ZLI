import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import type { CaptureSource, ZliBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";

type Capture = NonNullable<ZliBridge["capture"]>;

/** A PNG file named after the window it came from. */
export function captureFile(name: string, dataBase64: string): File {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "window";
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], `${stem}.png`, { type: "image/png" });
}

/** Lists open windows and screens with previews; picking one attaches a full-size picture of it. */
export function CapturePicker({
  capture,
  onPick,
  onClose,
}: {
  capture: Capture;
  onPick(file: File): void;
  onClose(): void;
}) {
  const [sources, setSources] = useState<CaptureSource[]>();
  const [error, setError] = useState<string>();
  const [taking, setTaking] = useState<string>();
  const firstRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setError(undefined);
    setSources(undefined);
    try {
      setSources(await capture.sources());
    } catch (cause) {
      setSources([]);
      setError(cause instanceof Error ? cause.message : "Open windows could not be listed.");
    }
  }, [capture]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasSources = (sources?.length ?? 0) > 0;
  useEffect(() => {
    if (hasSources) firstRef.current?.focus();
  }, [hasSources]);

  const take = async (source: CaptureSource) => {
    if (taking) return;
    setTaking(source.id);
    setError(undefined);
    try {
      const shot = await capture.take(source.id);
      onPick(captureFile(shot.name, shot.dataBase64));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The window could not be captured.");
    } finally {
      setTaking(undefined);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section className="capture-picker" aria-label="Attach a window" onKeyDown={onKeyDown}>
      <header className="capture-picker-header">
        <span className="capture-picker-title">Attach a picture of a window</span>
        <IconButton label="Refresh windows" icon="reload" size="xs" iconSize={12} onClick={() => void load()} />
        <IconButton label="Close window picker" icon="x" size="xs" iconSize={12} onClick={onClose} />
      </header>
      {sources === undefined ? (
        <p className="capture-picker-state" role="status">
          <span className="spinner" aria-hidden="true" />
          Looking for open windows
        </p>
      ) : sources.length === 0 ? (
        error ? null : (
          <p className="capture-picker-state">
            No windows to capture. Minimized windows do not show up.
            <Button size="xs" variant="ghost" onClick={() => void load()}>
              Try again
            </Button>
          </p>
        )
      ) : (
        <ul className="capture-grid">
          {sources.map((source, index) => (
            <li key={source.id}>
              <button
                ref={index === 0 ? firstRef : undefined}
                type="button"
                className="capture-source"
                disabled={taking !== undefined}
                aria-busy={taking === source.id}
                onClick={() => void take(source)}
              >
                <span className="capture-thumb">
                  {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <Icon name="monitor" size={18} />}
                  {taking === source.id ? <span className="spinner" aria-hidden="true" /> : null}
                </span>
                <span className="capture-name" title={source.name}>
                  <Icon name={source.kind === "screen" ? "monitor" : "appWindow"} size={11} />
                  <span>{source.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p className="composer-error" role="alert">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : null}
    </section>
  );
}
