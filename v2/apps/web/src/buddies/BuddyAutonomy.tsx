import {
  type BuddyProjection,
  type BuddyRules,
  overBudget,
  type RuntimeProjection,
  rulesOf,
  spentThisWeek,
} from "@zli-v2/contracts";
import { useState } from "react";

import { BrowserPane } from "../browser/BrowserPane.js";
import { IconButton } from "../ui/Button.js";
import { money } from "./team.js";
import type { Run } from "./useRun.js";

const GROUPS: readonly { key: keyof BuddyRules; label: string; add: string }[] = [
  { key: "alone", label: "Does on its own", add: "Add something it may just do" },
  { key: "ask", label: "Asks you first", add: "Add something it should ask about" },
  { key: "never", label: "Never does", add: "Add something it must never do" },
];

/**
 * What the buddy does on its own, asks first, and never does. It reads them at the start of every job and
 * chat, and asks first through Needs you, so the person answers there.
 */
export function RulesEditor({ buddy, run }: { buddy: BuddyProjection; run: Run }) {
  const rules = rulesOf(buddy);
  const save = (next: BuddyRules) => run({ type: "buddy.update", buddyId: buddy.buddyId, changes: { rules: next } });
  return (
    <section className="buddies-section" aria-label="Rules">
      <h3 className="buddies-heading">Rules</h3>
      <p className="buddies-hint">
        {buddy.name} reads these at the start of every job and chat. What it should ask about comes to you in Needs you.
      </p>
      {GROUPS.map((group) => (
        <RuleGroup
          key={group.key}
          label={group.label}
          addLabel={group.add}
          kind={group.key}
          items={rules[group.key]}
          onChange={(items) => void save({ ...rules, [group.key]: items })}
        />
      ))}
    </section>
  );
}

function RuleGroup({
  label,
  addLabel,
  kind,
  items,
  onChange,
}: {
  label: string;
  addLabel: string;
  kind: keyof BuddyRules;
  items: readonly string[];
  onChange(items: string[]): void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim().slice(0, 200);
    if (!text || items.length >= 12) return;
    if (!items.some((item) => item.toLowerCase() === text.toLowerCase())) onChange([...items, text]);
    setDraft("");
  };
  return (
    <div className={`rule-group is-${kind}`}>
      <h4 className="rule-group-head">{label}</h4>
      <ul className="rule-group-list">
        {items.map((item) => (
          <li key={item} className="rule-item">
            <span>{item}</span>
            <IconButton
              label={`Remove: ${item}`}
              icon="x"
              size="xs"
              onClick={() => onChange(items.filter((entry) => entry !== item))}
            />
          </li>
        ))}
      </ul>
      {items.length < 12 ? (
        <input
          className="input rule-add"
          aria-label={addLabel}
          placeholder={addLabel}
          maxLength={200}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      ) : null}
    </div>
  );
}

/** The most the buddy's jobs may cost in a week. Past it, its new jobs wait until the limit goes up. */
export function BudgetField({
  buddy,
  projection,
  run,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
}) {
  const now = new Date();
  const spent = spentThisWeek(projection, buddy.buddyId, now);
  const [draft, setDraft] = useState(buddy.budgetUsd ? String(buddy.budgetUsd) : "");
  const save = () => {
    const value = draft.trim() === "" ? 0 : Number(draft);
    if (!Number.isFinite(value) || value < 0) {
      setDraft(buddy.budgetUsd ? String(buddy.budgetUsd) : "");
      return;
    }
    if (value !== (buddy.budgetUsd ?? 0))
      void run({ type: "buddy.update", buddyId: buddy.buddyId, changes: { budgetUsd: Math.round(value * 100) / 100 } });
  };
  const over = overBudget(projection, buddy, now);
  return (
    <section className="buddies-section" aria-label="Weekly budget">
      <h3 className="buddies-heading">Weekly budget</h3>
      <p className="buddies-hint">
        {spent > 0 ? `${money(spent)} spent` : "Nothing spent"} in the last 7 days.{" "}
        {buddy.budgetUsd ? `Past ${money(buddy.budgetUsd)}, new jobs wait.` : "Leave it empty for no limit."}
      </p>
      <label className="budget-field">
        <span aria-hidden="true">$</span>
        <input
          className="input"
          aria-label="Weekly budget in dollars"
          inputMode="decimal"
          placeholder="No limit"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/[^0-9.]/gu, ""))}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="budget-unit">a week</span>
      </label>
      {over ? (
        <p className="budget-over" role="status">
          Limit reached: {buddy.name}'s new jobs wait until you raise it or older jobs leave the 7 days.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The buddy's own browser, where its web jobs work. It keeps its sign-ins apart from yours and the other
 * buddies', so this is where the person signs it in to a site, or watches it work and takes over.
 */
export function BuddyBrowser({ buddy, projection }: { buddy: BuddyProjection; projection: RuntimeProjection }) {
  const worktree = projection.worktrees.find((entry) => entry.worktreeId === buddy.home?.worktreeId);
  if (!worktree)
    return (
      <div className="buddy-browser is-empty">
        <p className="buddies-hint">
          {buddy.name}'s browser opens once it has a home: say hi in its chat, or give it a web job.
        </p>
      </div>
    );
  return (
    <div className="buddy-browser">
      <p className="buddy-browser-note">
        {buddy.name}'s own browser. Sign it in to sites here and it stays signed in for its web jobs; your sign-ins and
        other buddies' stay apart.
      </p>
      <div className="buddy-browser-pane">
        <BrowserPane worktree={worktree} />
      </div>
    </div>
  );
}
