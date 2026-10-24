import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { type DesignPick, designSize, designSummary, MAX_DESIGN_PICKS } from "./designMode.js";

/** Elements picked in design mode, with the request that goes to the agent along with them. */
export function DesignPanel({
  picks,
  note,
  picking,
  inspecting,
  canPick,
  onNoteChange,
  onPickAnother,
  onRemove,
  onClear,
  onSend,
}: {
  picks: readonly DesignPick[];
  note: string;
  picking: boolean;
  inspecting: boolean;
  canPick: boolean;
  onNoteChange(note: string): void;
  onPickAnother(): void;
  onRemove(id: string): void;
  onClear(): void;
  onSend(): void;
}) {
  const full = picks.length >= MAX_DESIGN_PICKS;
  const ready = note.trim().length > 0;
  return (
    <section className="browser-design" aria-label="Picked elements">
      <header className="browser-design-header">
        <Icon name="crosshair" size={13} />
        <span className="browser-design-title">
          {picks.length} element{picks.length === 1 ? "" : "s"} picked
        </span>
        {inspecting ? (
          <span className="browser-design-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Reading the element
          </span>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          icon="crosshair"
          disabled={!canPick || picking || full}
          tooltip={full ? `Send these first. Up to ${MAX_DESIGN_PICKS} elements go in one message.` : undefined}
          onClick={onPickAnother}
        >
          Pick another
        </Button>
        <IconButton label="Clear picked elements" tooltip="Clear" icon="x" size="xs" iconSize={12} onClick={onClear} />
      </header>
      <ul className="browser-design-picks">
        {picks.map((pick) => {
          const summary = designSummary(pick);
          const size = designSize(pick);
          return (
            <li className="browser-design-pick" key={pick.id}>
              {pick.screenshot ? (
                <img
                  className="browser-design-thumb"
                  src={`data:${pick.screenshot.mimeType};base64,${pick.screenshot.data}`}
                  alt={`Screenshot of ${summary}`}
                />
              ) : (
                <span className="browser-design-thumb is-empty" aria-hidden="true">
                  <Icon name="image" size={14} />
                </span>
              )}
              <span className="browser-design-pick-copy">
                <span className="browser-design-pick-name">{summary}</span>
                <span className="browser-design-pick-detail">
                  <code title={pick.selector}>{pick.selector}</code>
                  {size ? <span>{size}</span> : null}
                </span>
              </span>
              <IconButton
                label={`Remove ${summary}`}
                tooltip="Remove"
                icon="trash"
                size="xs"
                iconSize={12}
                onClick={() => onRemove(pick.id)}
              />
            </li>
          );
        })}
      </ul>
      <textarea
        className="textarea browser-design-note"
        aria-label="What should change?"
        placeholder="What should change?"
        rows={2}
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && ready) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="browser-design-actions">
        <Button size="sm" variant="primary" icon="message" shortcut="Mod+Enter" disabled={!ready} onClick={onSend}>
          Send to agent
        </Button>
      </div>
    </section>
  );
}
