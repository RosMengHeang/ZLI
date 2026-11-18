import {
  type BuddyProjection,
  type BuddyRules,
  firstSentence,
  overBudget,
  type RuntimeProjection,
  rulesOf,
  spentThisWeek,
} from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";

import { BrowserPane } from "../browser/BrowserPane.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import { IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
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

/** How often the screen card catches up: often while the buddy works on the web, rarely while it rests. */
const LIVE_MS = 3_000;
const RESTING_MS = 15_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The buddy's screen: a small live picture of its own browser, beside its chat. A click opens it full size,
 * where the person can take over: click, type, or sign it in to a site. Its sign-ins stay its own.
 */
export function BuddyScreen({
  buddy,
  projection,
  run,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
}) {
  const { bridge } = useRuntime();
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState<string>();
  const worktree = projection.worktrees.find((entry) => entry.worktreeId === buddy.home?.worktreeId);
  const tabs = (projection.browserTabs ?? []).filter((entry) => entry.worktreeId === worktree?.worktreeId);
  const tab = tabs.find((entry) => entry.active) ?? tabs.at(-1);
  const working = (projection.tasks ?? []).some(
    (task) =>
      task.buddyId === buddy.buddyId &&
      task.status === "working" &&
      task.worktreeId !== undefined &&
      task.worktreeId === worktree?.worktreeId,
  );
  const tabId = tab?.browserTabId;
  // The card only catches up while it is on screen and the app is in front.
  const frameRef = useRef<HTMLButtonElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver !== "function") return undefined;
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!bridge || !tabId || open || !onScreen) return undefined;
    let alive = true;
    const grab = async () => {
      if (document.hidden) return;
      try {
        const result = (await bridge.browser.screenshot({ browserTabId: tabId, format: "jpeg", thumbnail: true })) as
          | { data?: string; mimeType?: string }
          | undefined;
        if (alive && result?.data) setShot(`data:${result.mimeType ?? "image/jpeg"};base64,${result.data}`);
      } catch {
        // A tab still loading or just closed has no picture yet; the card keeps the last one.
      }
    };
    void grab();
    const timer = setInterval(() => void grab(), working ? LIVE_MS : RESTING_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bridge, tabId, open, working, onScreen]);

  return (
    <section className="buddy-screen" aria-label={`${buddy.name}'s screen`}>
      <button
        ref={frameRef}
        type="button"
        className="buddy-screen-frame"
        disabled={!worktree}
        aria-label={`Open ${buddy.name}'s screen`}
        title={worktree ? "Open full size to watch or take over" : undefined}
        onClick={() => setOpen(true)}
      >
        {shot && tab ? (
          <img src={shot} alt="" />
        ) : (
          <span className="buddy-screen-empty">
            <Icon name="globe" size={18} />
            {!worktree ? "Getting its browser ready" : tab ? tab.title || hostOf(tab.url) : "Nothing open yet"}
          </span>
        )}
        {working ? <span className="buddy-screen-live">Live</span> : null}
        {worktree ? (
          <span className="buddy-screen-expand" aria-hidden="true">
            <Icon name="maximize" size={13} />
          </span>
        ) : null}
      </button>
      <p className="buddy-screen-caption">
        {buddy.name}'s screen{tab?.url && tab.url !== "about:blank" ? ` · ${hostOf(tab.url)}` : ""}
      </p>
      {open && worktree ? (
        <Dialog
          label={`${buddy.name}'s browser`}
          size="lg"
          className="buddy-screen-dialog"
          showClose={false}
          stacked
          onClose={() => setOpen(false)}
        >
          <div className="buddy-screen-full">
            <BrowserPane
              worktree={worktree}
              chrome={{
                owner: (
                  <span className="chrome-owner-who">
                    <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={18} />
                    {buddy.name}'s browser
                  </span>
                ),
                ownerName: buddy.name,
                onClose: () => setOpen(false),
                banner: <ControlBar buddy={buddy} projection={projection} worktreeId={worktree.worktreeId} run={run} />,
              }}
            />
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * Who drives the buddy's browser while a web job runs. The buddy works and the person watches, with Take over;
 * after Take over its job waits and the person drives, with Hand back, which tells the buddy where they left it.
 */
function ControlBar({
  buddy,
  projection,
  worktreeId,
  run,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  worktreeId: string;
  run: Run;
}) {
  const job = (projection.tasks ?? []).find(
    (task) =>
      task.buddyId === buddy.buddyId &&
      task.worktreeId === worktreeId &&
      (task.status === "working" || task.needs?.kind === "takeover"),
  );
  if (!job) return null;
  if (job.needs?.kind === "takeover") {
    const tab = (projection.browserTabs ?? []).find((entry) => entry.worktreeId === worktreeId && entry.active);
    return (
      <div className="chrome-ctl is-you" role="status">
        <span className="chrome-ctl-dot" />
        <b>You're in control</b>
        <span className="chrome-ctl-step">· {buddy.name}'s job is paused</span>
        <button
          type="button"
          className="chrome-ctl-btn"
          onClick={() =>
            void run({
              type: "task.handback",
              taskId: job.taskId,
              ...(tab?.url && tab.url !== "about:blank"
                ? { note: `The browser is now on ${tab.url}`.slice(0, 500) }
                : {}),
            })
          }
        >
          Hand back
        </button>
      </div>
    );
  }
  return (
    <div className="chrome-ctl is-agent" role="status">
      <span className="chrome-ctl-dot" />
      <b>{buddy.name} is using this browser</b>
      <span className="chrome-ctl-step">· {firstSentence(job.goal, 90)}</span>
      <button
        type="button"
        className="chrome-ctl-btn"
        onClick={() => void run({ type: "task.takeover", taskId: job.taskId })}
      >
        Take over
      </button>
    </div>
  );
}
