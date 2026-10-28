import { useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import {
  DESIGN_EDITABLE_STYLES,
  type DesignAnnotation,
  type DesignEdits,
  type DesignElementAnnotation,
  designEditSummary,
  designEditsPreview,
  designSize,
  designSummary,
  diffDesignEdits,
} from "./designMode.js";

type Preview = ReturnType<typeof designEditsPreview>;

/** The annotations made in Annotate mode, each with its own instruction for the agent. */
export function DesignPanel({
  annotations,
  inspecting,
  canEdit,
  onInstructionChange,
  onRemove,
  onClear,
  onSend,
  ready,
  onPreview,
  onEdits,
}: {
  annotations: readonly DesignAnnotation[];
  inspecting: boolean;
  /** Edits preview on the live page, so they need the page the element came from with Annotate on. */
  canEdit(annotation: DesignElementAnnotation): boolean;
  onInstructionChange(id: string, instruction: string): void;
  onRemove(id: string): void;
  onClear(): void;
  onSend(): void;
  ready: boolean;
  onPreview(annotation: DesignElementAnnotation, preview: Preview): void;
  onEdits(id: string, edits: DesignEdits | undefined): void;
}) {
  const [editingId, setEditingId] = useState<string>();
  return (
    <section className="browser-design" aria-label="Annotations">
      <header className="browser-design-header">
        <Icon name="crosshair" size={13} />
        <span className="browser-design-title">
          {annotations.length} annotation{annotations.length === 1 ? "" : "s"}
        </span>
        {inspecting ? (
          <span className="browser-design-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Reading the page
          </span>
        ) : null}
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
          const editing = annotation.kind === "element" && editingId === annotation.id && annotation.editable;
          return (
            <li className="browser-design-pick" key={annotation.id}>
              <div className="browser-design-pick-row">
                <span className={`browser-design-index${annotation.kind === "region" ? " is-region" : ""}`}>{n}</span>
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
                  <span className="browser-design-pick-name">{summary}</span>
                  <span className="browser-design-pick-detail">
                    {annotation.kind === "element" ? (
                      <code title={annotation.selector}>{annotation.selector}</code>
                    ) : annotation.strokes.length > 0 ? (
                      <span>
                        {annotation.strokes.length} mark{annotation.strokes.length === 1 ? "" : "s"} drawn
                      </span>
                    ) : null}
                    {size ? <span>{size}</span> : null}
                    {edits ? <span className="browser-design-edits">{edits}</span> : null}
                  </span>
                </span>
                {annotation.kind === "element" && annotation.editable ? (
                  <IconButton
                    label={`Edit text and CSS of annotation ${n}`}
                    tooltip={
                      canEdit(annotation) ? "Edit text and CSS" : "Turn on Annotate on this page to preview edits"
                    }
                    icon="pencil"
                    size="xs"
                    iconSize={12}
                    pressed={Boolean(editing)}
                    disabled={!canEdit(annotation) && !editing}
                    onClick={() => {
                      if (editing) {
                        onPreview(annotation, designEditsPreview(annotation.edits));
                        setEditingId(undefined);
                      } else setEditingId(annotation.id);
                    }}
                  />
                ) : null}
                <IconButton
                  label={`Remove annotation ${n}`}
                  tooltip="Remove"
                  icon="x"
                  size="xs"
                  iconSize={12}
                  onClick={() => {
                    if (editingId === annotation.id) setEditingId(undefined);
                    onRemove(annotation.id);
                  }}
                />
              </div>
              <textarea
                className="textarea browser-design-note"
                aria-label={`Instruction for annotation ${n}`}
                placeholder={annotation.kind === "region" ? "What goes here?" : "What should change?"}
                rows={1}
                value={annotation.instruction}
                onChange={(event) => onInstructionChange(annotation.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && ready) {
                    event.preventDefault();
                    onSend();
                  }
                }}
              />
              {editing && annotation.kind === "element" && annotation.editable ? (
                <DesignEditor
                  annotation={annotation}
                  editable={annotation.editable}
                  onPreview={(preview) => onPreview(annotation, preview)}
                  onConfirm={(next) => {
                    onEdits(annotation.id, next);
                    onPreview(annotation, designEditsPreview(next));
                    setEditingId(undefined);
                  }}
                  onCancel={() => {
                    onPreview(annotation, designEditsPreview(annotation.edits));
                    setEditingId(undefined);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Text and a few styles, previewed on the page as they are typed and kept on the annotation with Add. */
function DesignEditor({
  annotation,
  editable,
  onPreview,
  onConfirm,
  onCancel,
}: {
  annotation: DesignElementAnnotation;
  editable: NonNullable<DesignElementAnnotation["editable"]>;
  onPreview(preview: Preview): void;
  onConfirm(edits: DesignEdits | undefined): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(annotation.edits?.text?.to ?? editable.text ?? "");
  const [styles, setStyles] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      DESIGN_EDITABLE_STYLES.map((property) => [
        property,
        annotation.edits?.css.find((edit) => edit.property === property)?.to ?? editable.styles[property] ?? "",
      ]),
    ),
  );
  const draft = (nextText: string, nextStyles: Record<string, string>) =>
    diffDesignEdits(editable, { ...(editable.text === null ? {} : { text: nextText }), styles: nextStyles });
  const edits = draft(text, styles);
  const count = edits ? edits.css.length + (edits.text ? 1 : 0) : 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape here closes the editor instead of leaving Annotate.
    <div
      className="browser-design-editor"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      {editable.text === null ? null : (
        <label className="browser-design-field">
          <span>Text</span>
          <input
            className="input input-sm"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              onPreview(designEditsPreview(draft(event.target.value, styles)));
            }}
          />
          {edits?.text ? <span className="browser-design-from">was {JSON.stringify(edits.text.from)}</span> : null}
        </label>
      )}
      {DESIGN_EDITABLE_STYLES.map((property) => {
        const change = edits?.css.find((edit) => edit.property === property);
        return (
          <label className="browser-design-field" key={property}>
            <span>{property}</span>
            <input
              className="input input-sm is-mono"
              value={styles[property] ?? ""}
              spellCheck={false}
              onChange={(event) => {
                const next = { ...styles, [property]: event.target.value };
                setStyles(next);
                onPreview(designEditsPreview(draft(text, next)));
              }}
            />
            {change ? <span className="browser-design-from">was {change.from || "unset"}</span> : null}
          </label>
        );
      })}
      <div className="browser-design-editor-actions">
        <span className="browser-design-editor-hint">
          Previewed on the page only. The agent makes the change in code.
        </span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Discard
        </Button>
        <Button size="xs" variant="primary" icon="plus" onClick={() => onConfirm(edits)}>
          {count > 0 ? `Add ${count} edit${count === 1 ? "" : "s"}` : "Add"}
        </Button>
      </div>
    </div>
  );
}
