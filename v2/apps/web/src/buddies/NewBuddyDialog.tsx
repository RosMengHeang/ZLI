import type { BuddyColor, BuddyLook, PermissionMode, RuntimeProjection } from "@zli-v2/contracts";
import { type FormEvent, useRef, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { BUDDY_COLOR_NAMES, buddyHex } from "../teammates/buddies.js";
import { BODIES, BUDDY_LOOKS, lookOf } from "../teammates/pixelBuddies.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Segmented } from "../ui/Segmented.js";
import { BUDDY_TEMPLATES, buddyFromTemplate, freeName, template } from "./team.js";
import { type Run, useRun } from "./useRun.js";

const ROLES = BUDDY_TEMPLATES.filter((entry) => entry.title !== "Primary");

const ACCESS: readonly { value: PermissionMode; label: string; tooltip: string }[] = [
  { value: "read-only", label: "Read only", tooltip: "Looks at code and reports back; changes nothing" },
  { value: "supervised", label: "Ask first", tooltip: "Asks you before it edits files or runs commands" },
  { value: "full-access", label: "Full access", tooltip: "Edits and runs commands in its own worktree" },
];

/** The first body nobody on the team has yet, so a new buddy stands apart. */
function freeLook(projection: RuntimeProjection): BuddyLook {
  const used = new Set((projection.buddies ?? []).filter((buddy) => !buddy.archived).map((buddy) => lookOf(buddy)));
  return BUDDY_LOOKS.find((look) => !used.has(look)) ?? "blob";
}

/** The first color nobody on the team wears yet, so a new buddy stands apart. */
function freeColor(projection: RuntimeProjection, wanted: BuddyColor): BuddyColor {
  const used = new Set((projection.buddies ?? []).filter((buddy) => !buddy.archived).map((buddy) => buddy.color));
  return used.has(wanted) ? (BUDDY_COLOR_NAMES.find((color) => !used.has(color)) ?? wanted) : wanted;
}

/**
 * Making a buddy: a name, what it does, its color, how much it may do, and what it should always keep in mind.
 * Picking what it does fills in the rest; anything the person changed by hand stays.
 */
export function NewBuddyDialog({
  projection,
  onClose,
  onCreated,
}: {
  projection: RuntimeProjection;
  onClose(): void;
  /** Opens the new buddy's chat. */
  onCreated(buddyId: string): void;
}) {
  const [error, setError] = useState<string>();
  const run: Run = useRun(setError);
  const first = ROLES[0] as (typeof ROLES)[number];
  const [role, setRole] = useState(first.title);
  const [name, setName] = useState("");
  const [color, setColor] = useState<BuddyColor>(() => freeColor(projection, first.color));
  const [look, setLook] = useState<BuddyLook>(() => freeLook(projection));
  const [access, setAccess] = useState<PermissionMode>(first.permissionMode);
  const [instructions, setInstructions] = useState(first.instructions);
  const touched = useRef({ color: false, instructions: false });
  const nameRef = useRef<HTMLInputElement>(null);

  const pickRole = (title: string) => {
    const entry = template(title);
    if (!entry) return;
    setRole(title);
    setAccess(entry.permissionMode);
    if (!touched.current.color) setColor(freeColor(projection, entry.color));
    if (!touched.current.instructions) setInstructions(entry.instructions);
  };
  const shownName = name.trim() || role;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const entry = template(role) ?? first;
    const buddyId = makeCommandId();
    const buddy = {
      ...buddyFromTemplate(buddyId, freeName(shownName, projection.buddies ?? []), entry),
      color,
      look,
      permissionMode: access,
      instructions: instructions.trim(),
      role: "buddy" as const,
    };
    if (await run({ type: "buddy.create", buddy })) onCreated(buddyId);
  };

  return (
    <Dialog label="New buddy" title="New buddy" size="md" initialFocusRef={nameRef} onClose={onClose}>
      <form className="new-buddy-form" onSubmit={(event) => void submit(event)}>
        <div className="dialog-body new-buddy">
          <div className="new-buddy-face">
            <BuddyAvatar buddy={color} look={look} size={56} />
            <span className="new-buddy-preview">{shownName}</span>
          </div>

          <label className="new-buddy-field">
            <span className="new-buddy-label">Name</span>
            <input
              ref={nameRef}
              className="input"
              value={name}
              placeholder={role}
              maxLength={24}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <fieldset className="new-buddy-field">
            <legend className="new-buddy-label">What it does</legend>
            <div className="new-buddy-roles">
              {ROLES.map((entry) => (
                <button
                  key={entry.title}
                  type="button"
                  className={`new-buddy-role${role === entry.title ? " is-on" : ""}`}
                  aria-pressed={role === entry.title}
                  onClick={() => pickRole(entry.title)}
                >
                  <span className="new-buddy-role-dot" style={{ background: buddyHex(entry.color) }} />
                  <span className="new-buddy-role-text">
                    <span className="new-buddy-role-name">{entry.title}</span>
                    <span className="new-buddy-role-blurb">{entry.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="new-buddy-field">
            <legend className="new-buddy-label">Body</legend>
            <div className="buddy-bodies">
              {BUDDY_LOOKS.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className="buddy-body-choice"
                  aria-label={BODIES[entry].label}
                  aria-pressed={look === entry}
                  onClick={() => setLook(entry)}
                >
                  <BuddyAvatar buddy={color} look={entry} size={32} />
                  <span>{BODIES[entry].label}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="new-buddy-field">
            <legend className="new-buddy-label">Color</legend>
            <div className="new-buddy-colors">
              {BUDDY_COLOR_NAMES.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={`new-buddy-color${color === entry ? " is-on" : ""}`}
                  aria-label={entry}
                  aria-pressed={color === entry}
                  style={{ background: buddyHex(entry) }}
                  onClick={() => {
                    touched.current.color = true;
                    setColor(entry);
                  }}
                />
              ))}
            </div>
          </fieldset>

          <div className="new-buddy-field">
            <span className="new-buddy-label">Most it may do</span>
            <Segmented<PermissionMode> label="Most it may do" value={access} options={ACCESS} onChange={setAccess} />
            <span className="new-buddy-hint">{ACCESS.find((entry) => entry.value === access)?.tooltip}.</span>
          </div>

          <label className="new-buddy-field">
            <span className="new-buddy-label">Standing instructions</span>
            <textarea
              className="input new-buddy-instructions"
              rows={4}
              maxLength={4_000}
              value={instructions}
              placeholder="What it should always keep in mind"
              onChange={(event) => {
                touched.current.instructions = true;
                setInstructions(event.target.value);
              }}
            />
          </label>

          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit">
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
