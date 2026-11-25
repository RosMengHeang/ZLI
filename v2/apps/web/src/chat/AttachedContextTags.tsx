import { useId, useState } from "react";

import { Collapse } from "../ui/Collapse.js";
import { Icon } from "../ui/Icon.js";
import { type AttachedContext, attachedText } from "./attachedContext.js";
import { CONTEXT_ICONS } from "./ComposerMenu.js";
import type { ContextKind } from "./contextSources.js";

/**
 * What a sent message had attached with "#" and "$", as tags under its words. A "#" tag opens the text
 * that went to the agent.
 */
export function AttachedContextTags({
  attachments,
  skills,
}: {
  attachments: readonly AttachedContext[];
  skills: readonly string[];
}) {
  const id = useId();
  const [view, setView] = useState<{ index: number; open: boolean }>({ index: 0, open: false });
  if (attachments.length === 0 && skills.length === 0) return null;
  // The closed block stays on screen while it shrinks away.
  const shown = attachments[view.index];
  return (
    <div className="chat-context">
      <ul className="chat-context-tags" aria-label="Attached">
        {attachments.map((attachment, index) => {
          const open = view.open && view.index === index;
          const label = attachment.label || "Attached text";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a sent message's blocks never change order.
            <li key={index}>
              <button
                type="button"
                className="chat-context-tag"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                title={label}
                onClick={() => setView({ index, open: !open })}
              >
                <Icon
                  className="chat-context-tag-icon"
                  name={CONTEXT_ICONS[attachment.kind as ContextKind] ?? "fileText"}
                  size={12}
                  aria-hidden="true"
                />
                <span className="chat-context-tag-label">{label}</span>
                <Icon
                  className="chat-context-tag-icon"
                  name={open ? "chevronUp" : "chevronDown"}
                  size={10}
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        })}
        {skills.map((name) => (
          <li key={`skill:${name}`}>
            <span className="chat-context-tag" title={`Asked for the ${name} skill`}>
              <Icon className="chat-context-tag-icon" name="puzzle" size={12} aria-hidden="true" />
              <span className="chat-context-tag-label">{name}</span>
            </span>
          </li>
        ))}
      </ul>
      {shown ? (
        <Collapse open={view.open}>
          <pre className="chat-context-text" id={id}>
            {attachedText(shown)}
          </pre>
        </Collapse>
      ) : null}
    </div>
  );
}
