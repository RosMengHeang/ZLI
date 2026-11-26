import {
  BUDDY_PERSONALITY_PRESETS,
  type BuddyProjection,
  buddiesInOrder,
  type HandoffAction,
  MAX_PERSONALITY,
  MAX_SAMPLE_REPLY,
  type MemoryNote,
  overBudget,
  type PermissionMode,
  type RuntimeProjection,
  spentThisWeek,
} from "@zli-v2/contracts";
import { type ReactNode, useState } from "react";

import { listedDiscoveries } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { relativeTime } from "../sessions/sessions.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Picker, type PickerOption } from "../ui/Picker.js";
import { RulesEditor, rulesSummary } from "./BuddyAutonomy.js";
import { BuddyModelPicker } from "./BuddyModelPicker.js";
import { exportBuddy, FULL_ACCESS_WARNING, money } from "./team.js";
import type { Run } from "./useRun.js";

/* ---------- Shared pieces ---------- */

/**
 * A dialog for writing one thing: a note, what the buddy is for, a voice. The tabs themselves never hold a text
 * box; writing happens here, and nothing is kept until Save.
 */
function WriteDialog({
  title,
  subtitle,
  label,
  initial,
  placeholder,
  rows = 1,
  maxLength,
  saveLabel = "Save",
  allowEmpty = false,
  numeric = false,
  extra,
  onSave,
  onClose,
}: {
  title: string;
  subtitle?: string | undefined;
  label: string;
  initial: string;
  placeholder?: string | undefined;
  /** More than one row makes it a text area. */
  rows?: number;
  maxLength: number;
  saveLabel?: string;
  /** Saving it empty clears the value. */
  allowEmpty?: boolean;
  numeric?: boolean;
  /** Another field under the main one, such as a sample line under a voice. */
  extra?: { label: string; initial: string; placeholder: string; maxLength: number } | undefined;
  onSave(value: string, extra: string): Promise<boolean> | boolean;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const [second, setSecond] = useState(extra?.initial ?? "");
  const [busy, setBusy] = useState(false);
  const ready = allowEmpty || value.trim().length > 0;
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const ok = await onSave(value.trim(), second.trim());
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog label={title} title={title} subtitle={subtitle} size={rows > 1 ? "md" : "sm"} onClose={onClose}>
      <form
        className="buddy-write"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog-body buddy-write-body">
          {rows > 1 ? (
            <textarea
              className="input buddy-write-area"
              aria-label={label}
              rows={rows}
              maxLength={maxLength}
              value={value}
              placeholder={placeholder}
              autoFocus
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <input
              className="input"
              aria-label={label}
              maxLength={maxLength}
              value={value}
              placeholder={placeholder}
              inputMode={numeric ? "decimal" : undefined}
              autoFocus
              onChange={(event) => setValue(numeric ? event.target.value.replace(/[^0-9.]/gu, "") : event.target.value)}
            />
          )}
          {extra ? (
            <input
              className="input"
              aria-label={extra.label}
              maxLength={extra.maxLength}
              value={second}
              placeholder={extra.placeholder}
              onChange={(event) => setSecond(event.target.value)}
            />
          ) : null}
        </div>
        <div className="dialog-footer">
          {rows > 1 ? (
            <span className="buddies-hint">
              {value.length} / {maxLength}
            </span>
          ) : null}
          <span className="buddy-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!ready || busy}>
            {saveLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** One setting: its name on the left, its value on the right, opened by a click. */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bset-row">
      <span className="bset-label">{label}</span>
      <span className="bset-value">{children}</span>
    </div>
  );
}

/** A quiet picker for a settings row: it shows the current choice and a chevron, like the chat's pickers. */
function ValuePicker<T extends string>({
  label,
  value,
  options,
  onChange,
  repick,
}: {
  label: string;
  value: T;
  options: readonly PickerOption<T>[];
  onChange(value: T): void;
  /** Picking this again reopens its editor. */
  repick?: T;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Picker label={label} value={value} options={options} onChange={onChange} repick={repick} className="bset-picker">
      <span className="picker-trigger-label">{current?.label ?? value}</span>
    </Picker>
  );
}

/* ---------- Library ---------- */

/** Where a note came from, said the way the person thinks of it. */
const NOTE_FROM: Record<MemoryNote["source"], string> = {
  you: "From you",
  told: "From you",
  lesson: "Learned on a job",
  lookback: "From your changes",
};

function projectName(projection: RuntimeProjection, projectId: string): string {
  return projection.projects.find((entry) => entry.projectId === projectId)?.name ?? "a project";
}

/**
 * What it has learned, as plain lists: lessons waiting for a yes, the notes it keeps, and the playbooks it wrote.
 * Adding a note opens a small dialog, so the tab itself is only reading.
 */
export function LibraryTab({
  buddy,
  projection,
  run,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
}) {
  const [writing, setWriting] = useState<{ kind: "add" } | { kind: "keep"; note: MemoryNote }>();
  const notes = [...buddy.memory].reverse();
  const playbooks = [...(buddy.playbooks ?? [])].sort((left, right) => right.at.localeCompare(left.at));
  const where = (projectId: string | undefined) => (projectId ? `, ${projectName(projection, projectId)}` : "");
  return (
    <div className="blib">
      {buddy.pendingMemory.length > 0 ? (
        <section className="blib-section" aria-label="New lessons">
          <h3 className="blib-heading">
            Wants to remember <span className="blib-count">{buddy.pendingMemory.length}</span>
          </h3>
          {buddy.pendingMemory.map((note) => (
            <div key={note.noteId} className="blib-ask">
              <p>{note.text}</p>
              <span className="blib-ask-actions">
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => void run({ type: "buddy.memory.accept", buddyId: buddy.buddyId, noteId: note.noteId })}
                >
                  Keep
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setWriting({ kind: "keep", note })}>
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void run({ type: "buddy.memory.remove", buddyId: buddy.buddyId, noteId: note.noteId })}
                >
                  Skip
                </Button>
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="blib-section" aria-label="What it knows">
        <h3 className="blib-heading">
          What it knows {notes.length > 0 ? <span className="blib-count">{notes.length}</span> : null}
          <span className="buddy-spacer" />
          <Button size="xs" variant="ghost" icon="plus" onClick={() => setWriting({ kind: "add" })}>
            Add
          </Button>
        </h3>
        {notes.length === 0 ? (
          <p className="blib-empty">Nothing yet. It keeps what you tell it and what its jobs learn.</p>
        ) : (
          <ul className="blib-list">
            {notes.map((note) => (
              <li key={note.noteId} className="blib-item">
                <span className="blib-item-body">
                  <span className="blib-item-text">{note.text}</span>
                  <span className="blib-item-meta">
                    {NOTE_FROM[note.source]}
                    {where(note.projectId)}, {relativeTime(note.at)}
                  </span>
                </span>
                <IconButton
                  label="Forget"
                  icon="x"
                  size="xs"
                  className="blib-remove"
                  onClick={() => void run({ type: "buddy.memory.remove", buddyId: buddy.buddyId, noteId: note.noteId })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="blib-section" aria-label="Playbooks">
        <h3 className="blib-heading">
          Playbooks {playbooks.length > 0 ? <span className="blib-count">{playbooks.length}</span> : null}
        </h3>
        {playbooks.length === 0 ? (
          <p className="blib-empty">None yet. When a job works out steps worth repeating, it saves them here.</p>
        ) : (
          <ul className="blib-list">
            {playbooks.map((playbook) => (
              <li key={playbook.playbookId} className="blib-item">
                <details className="blib-item-body">
                  <summary>
                    <span className="blib-item-text">{playbook.title}</span>
                    <span className="blib-item-meta">
                      {playbook.steps.length} {playbook.steps.length === 1 ? "step" : "steps"}
                      {where(playbook.projectId)}, {relativeTime(playbook.at)}
                    </span>
                  </summary>
                  <ol>
                    {playbook.steps.map((step, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: steps are fixed text in a fixed order.
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                </details>
                <IconButton
                  label={`Delete ${playbook.title}`}
                  icon="x"
                  size="xs"
                  className="blib-remove"
                  onClick={() =>
                    void run({ type: "buddy.playbook.remove", buddyId: buddy.buddyId, playbookId: playbook.playbookId })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {writing?.kind === "add" ? (
        <WriteDialog
          title={`Teach ${buddy.name} something`}
          subtitle="It reads what it knows before every chat and job."
          label="Note"
          initial=""
          placeholder="Such as: run pnpm test:web, not npm test"
          maxLength={400}
          saveLabel="Add"
          onSave={(text) =>
            run({
              type: "buddy.memory.add",
              buddyId: buddy.buddyId,
              note: { noteId: makeCommandId(), text, source: "you" },
            })
          }
          onClose={() => setWriting(undefined)}
        />
      ) : null}
      {writing?.kind === "keep" ? (
        <WriteDialog
          title="Edit the lesson"
          subtitle="It keeps it in these words."
          label="Lesson"
          initial={writing.note.text}
          maxLength={400}
          saveLabel="Keep"
          onSave={(text) =>
            run({ type: "buddy.memory.accept", buddyId: buddy.buddyId, noteId: writing.note.noteId, text })
          }
          onClose={() => setWriting(undefined)}
        />
      ) : null}
    </div>
  );
}

/* ---------- Settings ---------- */

const ACTIONS: readonly { value: HandoffAction; label: string }[] = [
  { value: "check", label: "checks it" },
  { value: "tests", label: "writes tests for it" },
  { value: "docs", label: "updates the docs" },
  { value: "fix", label: "fixes what's left" },
];

const ACCESS: readonly PickerOption<PermissionMode>[] = [
  { value: "read-only", label: "Read only", description: "Looks and reports; changes no files" },
  { value: "supervised", label: "Ask first", description: "Asks your yes before risky commands" },
  { value: "full-access", label: "Full access", description: "Works without stopping to ask" },
];

type Voice = "default" | (typeof BUDDY_PERSONALITY_PRESETS)[number] | "custom";

const VOICES: readonly PickerOption<Voice>[] = [
  { value: "default", label: "Default", description: "Warm and quick, a little playful" },
  { value: "warm", label: "Warm", description: "Kind, gentle when something breaks" },
  { value: "dry", label: "Dry", description: "Understated, deadpan" },
  { value: "cheerful", label: "Cheerful", description: "Upbeat, enjoys a win" },
  { value: "blunt", label: "Blunt", description: "Verdict first, no padding" },
  { value: "calm", label: "Calm", description: "Steady, unhurried" },
  { value: "custom", label: "In your words…", description: "Describe it yourself" },
];

function voiceOf(personality: string | undefined): Voice {
  if (!personality) return "default";
  return BUDDY_PERSONALITY_PRESETS.find((entry) => entry === personality.toLowerCase()) ?? "custom";
}

/** Weekly limits offered in the picker, in US dollars. 0 is no limit. */
const BUDGETS = [0, 5, 10, 25, 50, 100] as const;

type Writing = "here" | "voice" | "budget" | "rules" | "handoffs";

/**
 * Its settings as one short list: a name on the left, the choice on the right. Each opens a picker or a small
 * dialog, so the tab never holds a text box.
 */
export function SettingsTab({
  buddy,
  projection,
  run,
  onRemoved,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
  onRemoved(): void;
}) {
  const [writing, setWriting] = useState<Writing>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const others = buddiesInOrder(projection).filter((entry) => entry.buddyId !== buddy.buddyId);
  const providers = listedDiscoveries(projection.providers ?? []);
  const update = (changes: Record<string, unknown>) => run({ type: "buddy.update", buddyId: buddy.buddyId, changes });
  const focus = buddy.instructions?.trim();
  const voice = voiceOf(buddy.personality);
  const budget = buddy.budgetUsd ?? 0;
  const budgetValue = (BUDGETS as readonly number[]).includes(budget) ? String(budget) : "own";
  const spent = spentThisWeek(projection, buddy.buddyId, new Date());
  const handoffLine = (rule: BuddyProjection["handoffs"][number]) => {
    const to = others.find((entry) => entry.buddyId === rule.to);
    return `${to?.name ?? "A removed buddy"} ${ACTIONS.find((entry) => entry.value === rule.action)?.label ?? rule.action}`;
  };
  const close = () => setWriting(undefined);
  const download = () => {
    const file = exportBuddy(buddy, projection.routines ?? []);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${buddy.name.toLowerCase().replace(/\s+/gu, "-")}.buddy.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="bset">
      <button type="button" className="bset-here" onClick={() => setWriting("here")}>
        <span className="bset-label">
          Here for <span className="bset-edit">Edit</span>
        </span>
        <span className={`bset-here-text${focus ? "" : " is-empty"}`}>
          {focus ?? "Any job. Tell it what to focus on."}
        </span>
      </button>

      <div className="bset-list">
        <SettingRow label="Model">
          <BuddyModelPicker
            engine={buddy.engine}
            providers={providers}
            teamQuality={projection.buddySettings?.quality ?? "balanced"}
            onChange={(engine) => void update({ engine })}
          />
        </SettingRow>
        <SettingRow label="Most it may do">
          <ValuePicker<PermissionMode>
            label="Most it may do"
            value={buddy.permissionMode}
            options={ACCESS}
            onChange={(permissionMode) => void update({ permissionMode })}
          />
        </SettingRow>
        {buddy.permissionMode === "full-access" ? (
          <p className="bset-warning" role="note">
            {FULL_ACCESS_WARNING}
          </p>
        ) : null}
        <SettingRow label="Personality">
          <ValuePicker<Voice>
            label="Personality"
            value={voice}
            repick="custom"
            options={
              voice === "custom"
                ? VOICES.map((entry) =>
                    entry.value === "custom" ? { ...entry, label: buddy.personality ?? entry.label } : entry,
                  )
                : VOICES
            }
            onChange={(next) => {
              if (next === "custom") setWriting("voice");
              else void update({ personality: next === "default" ? "" : next });
            }}
          />
        </SettingRow>
        <SettingRow label="Weekly budget">
          <ValuePicker<string>
            label="Weekly budget"
            value={budgetValue}
            repick="own"
            options={[
              ...BUDGETS.map((amount) => ({
                value: String(amount),
                label: amount === 0 ? "No limit" : `${money(amount)} a week`,
              })),
              {
                value: "own",
                label: budgetValue === "own" ? `${money(budget)} a week` : "Another amount…",
                description: "Type your own limit",
              },
            ]}
            onChange={(value) => {
              if (value === "own") setWriting("budget");
              else void update({ budgetUsd: Number(value) });
            }}
          />
        </SettingRow>
        {overBudget(projection, buddy, new Date()) ? (
          <p className="bset-warning" role="status">
            Limit reached: new jobs wait. {money(spent)} spent in the last 7 days.
          </p>
        ) : null}
        <button type="button" className="bset-row is-link" onClick={() => setWriting("rules")}>
          <span className="bset-label">Rules</span>
          <span className="bset-value">
            <span className="bset-value-text">{rulesSummary(buddy)}</span>
            <Icon name="chevronRight" size={12} />
          </span>
        </button>
        <button type="button" className="bset-row is-link" onClick={() => setWriting("handoffs")}>
          <span className="bset-label">Passes work on</span>
          <span className="bset-value">
            <span className="bset-value-text">
              {buddy.handoffs.length === 0 ? "Nobody" : buddy.handoffs.map(handoffLine).join(", ")}
            </span>
            <Icon name="chevronRight" size={12} />
          </span>
        </button>
      </div>

      <div className="bset-actions">
        {buddy.role !== "primary" ? (
          <Button
            size="sm"
            icon="users"
            tooltip="The Primary plans bigger asks and hands the parts to the others"
            onClick={() => void run({ type: "buddy.setPrimary", buddyId: buddy.buddyId })}
          >
            Make Primary
          </Button>
        ) : null}
        <Button size="sm" icon="download" tooltip="Save it as a file you can import elsewhere" onClick={download}>
          Export
        </Button>
        <span className="buddy-spacer" />
        {confirmRemove ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              onClick={() =>
                void run({ type: "buddy.archive", buddyId: buddy.buddyId }).then((ok) => ok && onRemoved())
              }
            >
              Remove
            </Button>
          </>
        ) : (
          <IconButton
            label={`Remove ${buddy.name}`}
            icon="trash"
            size="sm"
            className="bset-remove"
            onClick={() => setConfirmRemove(true)}
          />
        )}
      </div>

      {writing === "here" ? (
        <WriteDialog
          title={`What ${buddy.name} is here for`}
          subtitle="Read at the start of every job. The Primary hands out work by it. Empty means any job."
          label="Here for"
          initial={buddy.instructions ?? ""}
          placeholder="Such as: keeps the docs in sync with the code, and runs pnpm test before finishing"
          rows={8}
          maxLength={4_000}
          allowEmpty
          onSave={(instructions) => update({ instructions })}
          onClose={close}
        />
      ) : null}
      {writing === "voice" ? (
        <WriteDialog
          title={`How ${buddy.name} sounds`}
          subtitle="Kept the same whichever model answers."
          label="Personality in your words"
          initial={voice === "custom" ? (buddy.personality ?? "") : ""}
          placeholder="Such as: patient, explains the why, a bit nerdy"
          maxLength={MAX_PERSONALITY}
          extra={{
            label: "Sample reply, optional",
            initial: buddy.sampleReply ?? "",
            placeholder: "A line the way it would say it, such as: Fixed. It was the cache, again.",
            maxLength: MAX_SAMPLE_REPLY,
          }}
          onSave={(personality, sampleReply) => update({ personality, sampleReply })}
          onClose={close}
        />
      ) : null}
      {writing === "budget" ? (
        <WriteDialog
          title="Weekly budget"
          subtitle={`Past it, new jobs wait. ${spent > 0 ? `${money(spent)} spent` : "Nothing spent"} in the last 7 days.`}
          label="Weekly budget in dollars"
          initial={budgetValue === "own" ? String(budget) : ""}
          placeholder="Dollars a week, such as 20"
          maxLength={9}
          numeric
          onSave={(value) => {
            const amount = Number(value);
            return Number.isFinite(amount) && amount > 0
              ? update({ budgetUsd: Math.round(amount * 100) / 100 })
              : false;
          }}
          onClose={close}
        />
      ) : null}
      {writing === "rules" ? (
        <Dialog
          label="Rules"
          title={`${buddy.name}'s rules`}
          subtitle="Read at the start of every job and chat. What it asks about comes to you in Needs you."
          size="md"
          onClose={close}
        >
          <div className="dialog-body">
            <RulesEditor buddy={buddy} run={run} />
          </div>
          <div className="dialog-footer">
            <span className="buddy-spacer" />
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </Dialog>
      ) : null}
      {writing === "handoffs" ? (
        <Dialog
          label="Passes work on"
          title="Passes work on"
          subtitle={`When ${buddy.name} finishes a job, the buddy you pick takes it next. A check sends it back if something is wrong, up to two rounds.`}
          size="md"
          onClose={close}
        >
          <div className="dialog-body bset-handoffs">
            {buddy.handoffs.map((rule) => (
              <div key={rule.ruleId} className="buddy-card buddy-rule">
                <span>
                  When it finishes, {handoffLine(rule)}
                  {rule.action === "check" ? `, up to ${rule.maxRounds} rounds` : ""}.
                </span>
                <IconButton
                  label="Remove rule"
                  icon="x"
                  size="xs"
                  onClick={() =>
                    void run({ type: "buddy.handoff.remove", buddyId: buddy.buddyId, ruleId: rule.ruleId })
                  }
                />
              </div>
            ))}
            {others.length > 0 ? (
              <AddRule buddy={buddy} others={others} run={run} />
            ) : (
              <p className="buddies-hint">Add another buddy to the team to pass work on.</p>
            )}
          </div>
          <div className="dialog-footer">
            <span className="buddy-spacer" />
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function AddRule({ buddy, others, run }: { buddy: BuddyProjection; others: BuddyProjection[]; run: Run }) {
  const [to, setTo] = useState(others[0]?.buddyId ?? "");
  const [action, setAction] = useState<HandoffAction>("check");
  return (
    <div className="buddy-rule-form">
      <span>When it finishes,</span>
      <Select
        label="Buddy"
        value={to}
        options={others.map((entry) => ({ value: entry.buddyId, label: entry.name }))}
        onChange={setTo}
      />
      <Select<HandoffAction> label="Does" value={action} options={ACTIONS} onChange={setAction} />
      <Button
        size="sm"
        onClick={() =>
          void run({
            type: "buddy.handoff.set",
            buddyId: buddy.buddyId,
            rule: { ruleId: makeCommandId(), when: "finished", to, action, maxRounds: 2, enabled: true },
          })
        }
      >
        Add rule
      </Button>
    </div>
  );
}
