import type { ProjectProjection } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import {
  deletePersonalPrompt,
  MAX_PROMPT_NAME,
  MAX_PROMPT_TEXT,
  type PersonalPrompt,
  savePersonalPrompt,
  usePersonalPrompts,
} from "./prompts.js";
import { useSharedPrompts } from "./useSharedPrompts.js";
import "./prompts.css";

type Editing = { id?: string; name: string; prompt: string };

export function PromptsDialog({
  project,
  initialDraft,
  onClose,
}: {
  project: ProjectProjection | undefined;
  initialDraft?: string | undefined;
  onClose(): void;
}) {
  const personal = usePersonalPrompts();
  const shared = useSharedPrompts(project?.projectId);
  const [editing, setEditing] = useState<Editing | undefined>(
    initialDraft?.trim() ? { name: "", prompt: initialDraft } : undefined,
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);
  const canSave = editing !== undefined && editing.name.trim().length > 0 && editing.prompt.trim().length > 0;

  const startEdit = (prompt?: PersonalPrompt) => {
    setConfirmDeleteId(undefined);
    setEditing(prompt ? { id: prompt.id, name: prompt.name, prompt: prompt.prompt } : { name: "", prompt: "" });
    requestAnimationFrame(() => nameRef.current?.focus());
  };
  const save = () => {
    if (!editing || !canSave) return;
    savePersonalPrompt({ ...(editing.id ? { id: editing.id } : {}), name: editing.name, prompt: editing.prompt });
    setEditing(undefined);
  };

  return (
    <Dialog
      label="Saved prompts"
      title="Saved prompts"
      subtitle='Insert one with "/" in a message or the first message of a new agent.'
      {...(initialDraft?.trim() ? { initialFocusRef: nameRef } : {})}
      onClose={onClose}
    >
      <div className="dialog-body prompt-manager-body">
        <section className="prompt-section" aria-labelledby="prompts-shared-title">
          <h3 className="prompt-section-title" id="prompts-shared-title">
            Shared in zli.json{project ? ` for ${project.name}` : ""}
          </h3>
          {shared.error ? (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={13} />
              {shared.error}
            </p>
          ) : shared.prompts.length === 0 ? (
            <p className="field-hint">
              None yet. Add a "prompts" list of names and prompts to zli.json to share them with the team.
            </p>
          ) : (
            <ul className="prompt-rows">
              {shared.prompts.map((entry, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: zli.json may repeat a name, and its order is stable.
                <li className="prompt-row" key={index}>
                  <span className="prompt-row-copy">
                    <strong>{entry.name}</strong>
                    <span>{entry.prompt}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="prompt-section" aria-labelledby="prompts-personal-title">
          <h3 className="prompt-section-title" id="prompts-personal-title">
            Personal, on this computer
          </h3>
          {personal.length === 0 && !editing ? (
            <p className="field-hint">Save prompts you reuse, such as a review checklist.</p>
          ) : personal.length > 0 ? (
            <ul className="prompt-rows">
              {personal.map((entry) => (
                <li className="prompt-row" key={entry.id}>
                  <span className="prompt-row-copy">
                    <strong>{entry.name}</strong>
                    <span>{entry.prompt}</span>
                  </span>
                  {confirmDeleteId === entry.id ? (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="is-danger"
                        onClick={() => {
                          deletePersonalPrompt(entry.id);
                          setConfirmDeleteId(undefined);
                          if (editing?.id === entry.id) setEditing(undefined);
                        }}
                      >
                        Delete
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setConfirmDeleteId(undefined)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <>
                      <IconButton
                        label={`Edit ${entry.name}`}
                        icon="pencil"
                        size="xs"
                        iconSize={12}
                        onClick={() => startEdit(entry)}
                      />
                      <IconButton
                        label={`Delete ${entry.name}`}
                        icon="trash"
                        size="xs"
                        iconSize={12}
                        onClick={() => setConfirmDeleteId(entry.id)}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {editing ? (
            <form
              className="prompt-editor"
              aria-label={editing.id ? "Edit prompt" : "New prompt"}
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <Field label="Name">
                <input
                  ref={nameRef}
                  className="input"
                  value={editing.name}
                  maxLength={MAX_PROMPT_NAME}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  placeholder="Review checklist"
                />
              </Field>
              <Field label="Prompt">
                <textarea
                  className="textarea"
                  rows={5}
                  value={editing.prompt}
                  maxLength={MAX_PROMPT_TEXT}
                  onChange={(event) => setEditing({ ...editing, prompt: event.target.value })}
                />
              </Field>
              <div className="prompt-editor-actions">
                <Button onClick={() => setEditing(undefined)}>Cancel</Button>
                <Button variant="primary" type="submit" disabled={!canSave}>
                  {editing.id ? "Save changes" : "Save prompt"}
                </Button>
              </div>
            </form>
          ) : (
            <Button className="prompt-new" icon="plus" onClick={() => startEdit()}>
              New prompt
            </Button>
          )}
        </section>
      </div>
    </Dialog>
  );
}
