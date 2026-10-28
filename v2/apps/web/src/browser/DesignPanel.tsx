import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { type DesignAnnotation, designEditSummary, designSize, designSummary } from "./designMode.js";

/** The annotations waiting to go to the agent. Their notes are written on the page, next to what they point at. */
export function DesignPanel({
  annotations,
  inspecting,
  annotating,
  onRemove,
  onClear,
}: {
  annotations: readonly DesignAnnotation[];
  inspecting: boolean;
  annotating: boolean;
  onRemove(id: string): void;
  onClear(): void;
}) {
  return (
    <section className="browser-design" aria-label="Annotations">
      <header className="browser-design-header">
        <span className="browser-design-title">
          {annotations.length} annotation{annotations.length === 1 ? "" : "s"}
        </span>
        {inspecting ? (
          <span className="browser-design-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Reading the page
          </span>
        ) : annotating ? null : (
          <span className="browser-design-status">Turn on Annotate to edit notes on the page.</span>
        )}
        <Button size="xs" variant="ghost" icon="trash" onClick={onClear}>
          Clear all
        </Button>
      </header>
      <ol className="browser-design-picks">
        {annotations.map((annotation, index) => {
          const n = index + 1;
          const summary = designSummary(annotation);
          const size = designSize(annotation);
          const edits = annotation.kind === "element" ? designEditSummary(annotation.edits) : undefined;
          const instruction = annotation.instruction.trim();
          return (
            <li className="browser-design-pick" key={annotation.id}>
              <span className="browser-design-index">{n}</span>
              {annotation.screenshot ? (
                <img
                  className="browser-design-thumb"
                  src={`data:${annotation.screenshot.mimeType};base64,${annotation.screenshot.data}`}
                  alt={`Screenshot of annotation ${n}, ${summary}`}
                />
              ) : (
                <span className="browser-design-thumb is-empty" aria-hidden="true">
                  <Icon name="image" size={14} />
                </span>
              )}
              <span className="browser-design-pick-copy">
                <span className="browser-design-pick-name">
                  <code>{summary}</code>
                  {size ? <span>{size}</span> : null}
                  {annotation.kind === "region" && annotation.strokes.length > 0 ? (
                    <span>
                      {annotation.strokes.length} mark{annotation.strokes.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {edits ? <span className="browser-design-edits">{edits}</span> : null}
                </span>
                <span className={`browser-design-pick-note${instruction ? "" : " is-empty"}`}>
                  {instruction || "No note yet"}
                </span>
              </span>
              <IconButton
                label={`Remove annotation ${n}`}
                tooltip="Remove"
                icon="x"
                size="xs"
                iconSize={12}
                onClick={() => onRemove(annotation.id)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
