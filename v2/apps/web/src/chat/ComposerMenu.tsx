import { agentNameKey, type SkillListResult } from "@zli-v2/contracts";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";

import { useFileIndex } from "../files/FileIndex.js";
import { baseName, dirName } from "../files/filePaths.js";
import { matchPrompts, type SavedPrompt } from "../prompts/prompts.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { listSkills } from "../settings/skills.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { Icon, type IconName } from "../ui/Icon.js";
import {
  type ComposerChip,
  type ComposerCommand,
  type ComposerTrigger,
  detectTrigger,
  fileMention,
  type MentionOption,
  matchCommands,
  matchFiles,
  matchSkills,
  personChip,
  replaceTrigger,
  type SkillChoice,
  skillChoices,
} from "./composerTriggers.js";
import {
  CONTEXT_GROUPS,
  type ContextChoice,
  type ContextKind,
  matchContext,
  useContextChoices,
} from "./contextSources.js";
import { FileBadge } from "./FileBadge.js";
import "../prompts/prompts.css";

type Item =
  | { kind: "teammate"; key: string; group: string; option: MentionOption }
  | { kind: "file"; key: string; group: string; path: string }
  | { kind: "context"; key: string; group: string; choice: ContextChoice }
  | { kind: "skill"; key: string; group: string; skill: SkillChoice }
  | { kind: "command"; key: string; group: string; command: ComposerCommand }
  | { kind: "prompt"; key: string; group: string; prompt: SavedPrompt };

const PROMPT_GROUPS: Record<SavedPrompt["source"], string> = {
  shared: "Shared in zli.json",
  personal: "Saved prompts",
  plugin: "From plugins",
};

const SKILLS_MAX_AGE_MS = 30_000;
const SKILL_MENTION = /(^|\s)\$[a-zA-Z]/u;
const skillCache = new Map<string, { at: number; result: Promise<SkillListResult> }>();

/** Skills for the "$" list, loaded the first time it opens and kept for half a minute. */
function useSkillList(projectId: string | undefined, wanted: boolean): SkillListResult | undefined | "error" {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<{ key: string; value: SkillListResult | "error" }>();
  const key = projectId ?? "";
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    let cached = skillCache.get(key);
    if (!cached || Date.now() - cached.at > SKILLS_MAX_AGE_MS) {
      cached = { at: Date.now(), result: listSkills(dispatch, projectId) };
      skillCache.set(key, cached);
    }
    cached.result.then(
      (result) => {
        if (!cancelled) setState({ key, value: result });
      },
      () => {
        skillCache.delete(key);
        if (!cancelled) setState({ key, value: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dispatch, key, projectId, wanted]);
  return state?.key === key ? state.value : undefined;
}

/** Forgets loaded skills, so the next "$" asks the runtime again. For tests. */
export function resetComposerSkillCache(): void {
  skillCache.clear();
}

export const CONTEXT_ICONS: Record<ContextKind, IconName> = {
  diff: "diff",
  chat: "message",
  pullRequest: "pullRequest",
  issue: "issue",
  branch: "branch",
  terminal: "terminal",
  browser: "globe",
};

/**
 * The list that opens from the word at the caret: "@" for files in the worktree, teammates, and buddies,
 * "#" for chats, pull requests, the diff and more, "$" for skills, "/" at the start for commands and saved
 * prompts. Focus stays in the text box, which passes its keys here first. With `onChip`, a pick becomes a
 * chip instead of text.
 */
export function useComposerMenu({
  draft,
  setDraft,
  textareaRef,
  mentions,
  worktreeId,
  projectId,
  provider,
  agentName,
  commands,
  prompts,
  promptFooter,
  promptWarning,
  onChip,
  currentChat,
}: {
  draft: string;
  setDraft(next: string): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  mentions: readonly MentionOption[];
  /** Where "@" looks for files. Without one, "@" offers only teammates. */
  worktreeId: string | undefined;
  /** Whose project skills "$" lists besides the person's own. */
  projectId: string | undefined;
  provider: string | undefined;
  agentName: string;
  commands: readonly ComposerCommand[];
  prompts: readonly SavedPrompt[];
  /** Buttons at the end of the footer while "/" is open. */
  promptFooter?: ReactNode;
  promptWarning?: string | undefined;
  /** Takes a picked teammate, file, skill, or "#" item as a chip. Without it, picks go in as text and "#" is off. */
  onChip?: ((chip: ComposerChip) => void) | undefined;
  /** The chat this box belongs to, left out of "#". */
  currentChat?: string | undefined;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(() => draft.length);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string>();
  const trigger = detectTrigger(draft, Math.min(caret, draft.length));
  const kind = trigger?.kind;
  const query = trigger?.query ?? "";
  const index = useFileIndex(kind === "file" ? worktreeId : undefined, { maxAgeMs: 15_000 });
  const context = useContextChoices({
    wanted: kind === "context" && Boolean(onChip),
    worktreeId,
    projectId,
    currentChat,
  });
  // A typed "$name" needs the list too, so sending can tell a skill from a price.
  const skillList = useSkillList(projectId, kind === "skill" || SKILL_MENTION.test(draft));
  const skills = useMemo(
    () => skillChoices(skillList === "error" ? undefined : skillList, provider),
    [skillList, provider],
  );

  const skillNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);

  const items = useMemo((): Item[] => {
    if (!kind) return [];
    if (kind === "file") {
      const wanted = agentNameKey(query);
      // A buddy is also found by what it is for, so "@review" finds one titled Reviewer.
      const people: Item[] = mentions
        .filter(
          (option) =>
            agentNameKey(option.name).startsWith(wanted) ||
            (option.kind === "buddy" && wanted !== "" && option.detail.toLowerCase().includes(query.toLowerCase())),
        )
        .map((option) => ({
          kind: "teammate",
          key: `teammate:${option.name}`,
          group: option.kind === "buddy" ? "Buddies" : option.kind === "peer" ? "In other chats" : "Teammates",
          option,
        }));
      const teammates = [
        ...people.filter((item) => item.group === "Teammates"),
        ...people.filter((item) => item.group === "In other chats"),
        ...people.filter((item) => item.group === "Buddies"),
      ];
      const files: Item[] = matchFiles(query, index?.entries ?? []).map((path) => ({
        kind: "file",
        key: `file:${path}`,
        group: "Files",
        path,
      }));
      return [...teammates, ...files];
    }
    if (kind === "context") {
      return matchContext(query, context.choices).map((choice) => ({
        kind: "context",
        key: `context:${choice.key}`,
        group: CONTEXT_GROUPS[choice.kind],
        choice,
      }));
    }
    if (kind === "skill") {
      return matchSkills(query, skills).map((skill) => ({
        kind: "skill",
        key: `skill:${skill.name}`,
        group: "Skills",
        skill,
      }));
    }
    const own: Item[] = matchCommands(query, commands).map((command) => ({
      kind: "command",
      key: `command:${command.name}`,
      group: command.source === "agent" ? `${agentName} commands` : "Commands",
      command,
    }));
    const ordered = [
      ...own.filter((item) => item.group === "Commands"),
      ...own.filter((item) => item.group !== "Commands"),
    ];
    const saved: Item[] = matchPrompts(prompts, query).map((prompt) => ({
      kind: "prompt",
      key: `prompt:${prompt.key}`,
      group: PROMPT_GROUPS[prompt.source],
      prompt,
    }));
    return [...ordered, ...saved];
  }, [kind, query, mentions, index, context.choices, skills, commands, prompts, agentName]);

  const loading =
    (kind === "file" && Boolean(worktreeId) && !index && items.length === 0) ||
    (kind === "skill" && skillList === undefined) ||
    (kind === "context" && context.loading && items.length === 0);
  // An empty list stays shut once something is typed after the trigger, so "$" or "@" in prose is quiet.
  const empty = items.length === 0 && !loading;
  // Only "$" and "#" explain an empty list, and only before a name is typed.
  const emptyHint =
    kind === "context"
      ? onChip && context.choices.length === 0
        ? "Nothing to attach yet. Chats, pull requests, changes, and terminals show up here."
        : undefined
      : kind !== "skill"
        ? undefined
        : skillList === "error"
          ? "Skills could not be loaded."
          : skills.length === 0
            ? "No skills yet. Add them in Settings, Skills."
            : undefined;
  const open = trigger !== undefined && dismissedAt !== draft && (!empty || (query === "" && Boolean(emptyHint)));
  const active = open ? items[Math.min(activeIndex, items.length - 1)] : undefined;
  const activeId = active ? `${listId}-${items.indexOf(active)}` : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlighted row follows the keyboard.
  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  /** Puts the caret at `position` once `text` is in the box. Text typed before the next frame keeps its caret. */
  const focusAt = (position: number, text: string) => {
    setCaret(position);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea || textarea.value !== text) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  const apply = (current: ComposerTrigger, replacement: string) => {
    const next = replaceTrigger(draft, current, replacement);
    setDraft(next.text);
    focusAt(next.caret, next.text);
  };

  const chipFor = (item: Item): ComposerChip | undefined => {
    switch (item.kind) {
      case "teammate":
        return personChip(item.option);
      case "file":
        return { kind: "file", key: `file:${item.path}`, label: baseName(item.path), path: item.path };
      case "skill":
        return { kind: "skill", key: `skill:${item.skill.name}`, label: item.skill.name, name: item.skill.name };
      case "context":
        return { kind: "context", key: item.key, label: item.choice.label, choice: item.choice };
      default:
        return undefined;
    }
  };

  const pick = (item: Item) => {
    if (!trigger) return;
    const chip = onChip ? chipFor(item) : undefined;
    if (chip && onChip) {
      apply(trigger, "");
      onChip(chip);
      return;
    }
    switch (item.kind) {
      case "teammate":
        apply(trigger, `@${item.option.name}`);
        return;
      case "file":
        apply(trigger, fileMention(item.path));
        return;
      case "skill":
        apply(trigger, `$${item.skill.name}`);
        return;
      case "context":
        return;
      case "prompt": {
        // A prompt is the message itself, so it goes in as written, with no space after it.
        const text = item.prompt.prompt + draft.slice(trigger.end).replace(/^\S*/u, "");
        setDraft(text);
        focusAt(item.prompt.prompt.length, text);
        return;
      }
      case "command":
        if (item.command.insert !== undefined) {
          apply(trigger, item.command.insert);
          return;
        }
        apply(trigger, "");
        item.command.run?.();
    }
  };

  /** Returns true when the menu used the key, so the text box should not act on it. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      // Closing the list must not also close the dialog or tile around it.
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(draft);
      return true;
    }
    if (items.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (Math.min(current, items.length - 1) + step + items.length) % items.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && active) {
      event.preventDefault();
      pick(active);
      return true;
    }
    return false;
  };

  const trackCaret = (event: { currentTarget: HTMLTextAreaElement }) => {
    const next = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
    if (next !== caret) setActiveIndex(0);
    setCaret(next);
  };

  const label =
    kind === "file"
      ? "Files, teammates, and buddies"
      : kind === "context"
        ? "Chats, pull requests, and changes"
        : kind === "skill"
          ? "Skills"
          : "Commands";
  const list = open ? (
    <div className="prompt-picker composer-menu">
      <div className="prompt-options" id={listId} role="listbox" aria-label={label} ref={listRef}>
        {loading && items.length === 0 ? (
          <p className="prompt-empty loading-line">
            {kind === "skill" ? "Loading skills" : kind === "context" ? "Loading" : "Loading files"}
          </p>
        ) : null}
        {items.length === 0 && !loading && emptyHint ? <p className="prompt-empty">{emptyHint}</p> : null}
        {items.map((item, position) => {
          const startsGroup = position === 0 || items[position - 1]?.group !== item.group;
          return (
            <div key={item.key} role="presentation">
              {startsGroup ? (
                <p className="prompt-group" aria-hidden="true">
                  {item.group}
                </p>
              ) : null}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the text box handles the keyboard for the list. */}
              <div
                id={`${listId}-${position}`}
                className={`prompt-option composer-menu-option${item === active ? " is-active" : ""}`}
                role="option"
                aria-selected={item === active}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (item !== active) setActiveIndex(position);
                }}
                onClick={() => pick(item)}
              >
                <MenuRow item={item} />
              </div>
            </div>
          );
        })}
      </div>
      {kind === "command" && promptWarning ? (
        <p className="prompt-warning" role="status">
          <Icon name="alert" size={12} />
          Shared prompts are unavailable. {promptWarning}
        </p>
      ) : null}
      <div className="prompt-footer">
        <span aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move, <kbd>↵</kbd> to pick, <kbd>Esc</kbd> to close
        </span>
        {kind === "command" ? promptFooter : null}
      </div>
    </div>
  ) : null;

  return {
    open,
    trigger: open ? trigger : undefined,
    /** Skills the agent can load, once the list has been asked for. */
    skillNames,
    list,
    onKeyDown,
    trackCaret,
    /** Combobox wiring for the text box the menu belongs to. */
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": activeId,
    },
  };
}

function MenuRow({ item }: { item: Item }) {
  switch (item.kind) {
    case "teammate":
      return (
        <>
          <BuddyAvatar buddy={item.option.buddy} provider={item.option.provider} size={22} />
          <span className="composer-menu-copy">
            <span className="prompt-option-name">{item.option.name}</span>
            <span className="prompt-option-text">{item.option.detail}</span>
          </span>
        </>
      );
    case "file": {
      const folder = dirName(item.path);
      return (
        <>
          <FileBadge path={item.path} size="sm" />
          <span className="composer-menu-line">
            <span className="prompt-option-name">{baseName(item.path)}</span>
            {folder ? <span className="composer-menu-path">{folder}</span> : null}
          </span>
        </>
      );
    }
    case "context":
      return (
        <>
          <span className="composer-menu-icon" aria-hidden="true">
            <Icon name={CONTEXT_ICONS[item.choice.kind]} size={13} />
          </span>
          <span className="composer-menu-line">
            <span className="prompt-option-name">{item.choice.label}</span>
            {item.choice.detail ? <span className="composer-menu-path">{item.choice.detail}</span> : null}
          </span>
        </>
      );
    case "skill":
      return (
        <>
          <span className="composer-menu-icon" aria-hidden="true">
            <Icon name="puzzle" size={13} />
          </span>
          <span className="composer-menu-copy">
            <span className="prompt-option-name">
              {item.skill.name}
              {item.skill.scope === "project" ? <span className="composer-menu-tag">Project</span> : null}
            </span>
            {item.skill.description ? <span className="prompt-option-text">{item.skill.description}</span> : null}
          </span>
        </>
      );
    case "command":
      return (
        <>
          <span className="composer-menu-icon" aria-hidden="true">
            <Icon name={item.command.source === "agent" ? "terminal" : "command"} size={13} />
          </span>
          <span className="composer-menu-line">
            <span className="prompt-option-name">/{item.command.name}</span>
            <span className="prompt-option-text">{item.command.description}</span>
          </span>
        </>
      );
    case "prompt":
      return (
        <>
          <span className="composer-menu-icon" aria-hidden="true">
            <Icon name="bookmark" size={13} />
          </span>
          <span className="composer-menu-copy">
            <span className="prompt-option-name">{item.prompt.name}</span>
            <span className="prompt-option-text">{item.prompt.prompt}</span>
          </span>
        </>
      );
  }
}
