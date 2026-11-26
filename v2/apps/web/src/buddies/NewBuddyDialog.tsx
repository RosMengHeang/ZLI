import type { BuddyColor, BuddyEngine, BuddyLook, PermissionMode, RuntimeProjection } from "@zli-v2/contracts";
import { type FormEvent, useRef, useState } from "react";

import { listedDiscoveries } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { BUDDY_COLOR_NAMES, buddyHex } from "../teammates/buddies.js";
import { BODIES, BUDDY_LOOKS, lookOf } from "../teammates/pixelBuddies.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Segmented } from "../ui/Segmented.js";
import { BuddyModelPicker } from "./BuddyModelPicker.js";
import { FULL_ACCESS_WARNING, focusQuestion } from "./team.js";
import { type Run, useRun } from "./useRun.js";

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

/** The wanted color if nobody on the team wears it yet, else the first free one, so a new buddy stands apart. */
function freeColor(projection: RuntimeProjection, wanted?: BuddyColor): BuddyColor {
  const used = new Set((projection.buddies ?? []).filter((buddy) => !buddy.archived).map((buddy) => buddy.color));
  if (wanted && !used.has(wanted)) return wanted;
  return BUDDY_COLOR_NAMES.find((color) => !used.has(color)) ?? wanted ?? "sky";
}

/**
 * Making a buddy: a name, which model it runs, how much it may do, and a body. What it is for is not asked
 * here: the new buddy asks in its chat, and keeps the answer as its focus.
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
  const teamQuality = projection.buddySettings?.quality ?? "balanced";
  const [name, setName] = useState("");
  const [color, setColor] = useState<BuddyColor>(() => freeColor(projection));
  const [look, setLook] = useState<BuddyLook>(() => freeLook(projection));
  const [access, setAccess] = useState<PermissionMode>("supervised");
  const [engine, setEngine] = useState<BuddyEngine>({ mode: "auto", quality: teamQuality });
  const touched = useRef({ color: false });
  const nameRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const taken = (projection.buddies ?? []).some(
    (buddy) => !buddy.archived && buddy.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const [tried, setTried] = useState(false);
  const nameProblem = !trimmed ? "Give it a name." : taken ? `Another buddy is already called ${trimmed}.` : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (nameProblem) {
      nameRef.current?.focus();
      return;
    }
    const buddyId = makeCommandId();
    const buddy = {
      buddyId,
      name: trimmed,
      color,
      look,
      role: "buddy" as const,
      engine,
      permissionMode: access,
      maxActiveJobs: 2,
      handoffs: [],
    };
    if (!(await run({ type: "buddy.create", buddy }))) return;
    // Its first words ask what it is for; the chat offers answers under the question.
    await run({
      type: "buddy.chat.reply",
      buddyId,
      messageId: makeCommandId(),
      text: focusQuestion(trimmed),
      asks: "focus",
    });
    onCreated(buddyId);
  };

  return (
    <Dialog label="New buddy" title="New buddy" size="md" initialFocusRef={nameRef} onClose={onClose}>
      <form className="new-buddy-form" onSubmit={(event) => void submit(event)}>
        <div className="dialog-body new-buddy">
          <div className="new-buddy-face">
            <BuddyAvatar buddy={color} look={look} size={56} />
            <span className="new-buddy-preview">{trimmed || "New buddy"}</span>
          </div>

          <label className="new-buddy-field">
            <span className="new-buddy-label">Name</span>
            <input
              ref={nameRef}
              className="input"
              value={name}
              placeholder="Such as Nova"
              maxLength={24}
              aria-required="true"
              aria-invalid={tried && nameProblem ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {tried && nameProblem ? (
              <span className="new-buddy-hint is-warning" role="alert">
                {nameProblem}
              </span>
            ) : null}
          </label>

          <div className="new-buddy-field">
            <span className="new-buddy-label">Model</span>
            <BuddyModelPicker
              engine={engine}
              providers={listedDiscoveries(projection.providers ?? [])}
              teamQuality={teamQuality}
              onChange={setEngine}
              field
            />
            <span className="new-buddy-hint">
              {engine.mode === "auto"
                ? "Auto picks the agent, model and effort for each job, and learns from how jobs go."
                : "Every job runs on this model."}
            </span>
          </div>

          <div className="new-buddy-field">
            <span className="new-buddy-label">Most it may do</span>
            <Segmented<PermissionMode> label="Most it may do" value={access} options={ACCESS} onChange={setAccess} />
            <span className="new-buddy-hint">{ACCESS.find((entry) => entry.value === access)?.tooltip}.</span>
            {access === "full-access" ? (
              <span className="new-buddy-hint is-warning" role="note">
                {FULL_ACCESS_WARNING}
              </span>
            ) : null}
          </div>

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
