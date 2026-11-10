import type { ProjectProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useBranches } from "../review/branches.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import type { ChatPlace } from "../sessions/launch.js";
import { scrollMovesAnchor, useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Icon } from "../ui/Icon.js";

type Option = {
  key: string;
  label: string;
  detail?: string | undefined;
  icon: ReactNode;
  current?: boolean;
  disabled?: boolean;
  mono?: boolean;
  place?: ChatPlace;
};

type Group = { label?: string; options: Option[] };

/** The project's own folder, as opposed to a worktree ZLI made. Only the project's own copy is a checkout. */
const isLocal = (worktree: WorktreeProjection) => worktree.kind === "checkout";

const folderName = (path: string) => path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;

/**
 * The tab the message box sits on: the folder, whether it is the project's own copy or a worktree, and the
 * branch. Before the first message each part opens a menu that moves the chat to another project, worktree,
 * or branch. Once the agent has started, its folder is fixed and the tab only says where it works.
 */
export function WorkspaceBar({
  project,
  projects,
  worktree,
  worktrees,
  git,
  onMove,
}: {
  project: ProjectProjection | undefined;
  projects: readonly ProjectProjection[];
  worktree: WorktreeProjection;
  worktrees: readonly WorktreeProjection[];
  /** The project is a Git repository, so it has branches. */
  git: boolean;
  onMove?: ((place: ChatPlace) => Promise<string | undefined>) | undefined;
}) {
  const [open, setOpen] = useState<"folder" | "branch">();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string>();
  const local = isLocal(worktree);
  const folder = project?.name ?? folderName(worktree.path);

  const move = async (place: ChatPlace) => {
    if (!onMove) return;
    setOpen(undefined);
    setMoving(true);
    setError(undefined);
    try {
      const failure = await onMove(place);
      if (failure) setError(failure);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The chat could not move.");
    } finally {
      setMoving(false);
    }
  };

  const folderGroups: Group[] = [
    {
      options: projects.map((candidate) => ({
        key: candidate.projectId,
        label: candidate.name,
        detail: candidate.path,
        icon: <Icon name="folder" size={14} />,
        current: candidate.projectId === worktree.projectId,
        place: { kind: "project", projectId: candidate.projectId },
      })),
    },
  ];

  return (
    <div className={`composer-workspace${moving ? " is-moving" : ""}`}>
      <PlaceButton
        className="is-folder"
        icon="folder"
        label={folder}
        title={worktree.path}
        menuLabel="Move this chat to another project"
        open={open === "folder"}
        enabled={!!onMove && projects.length > 1 && !moving}
        onOpen={(next) => setOpen(next ? "folder" : undefined)}
        groups={folderGroups}
        onPick={move}
      />
      {git ? (
        <BranchButton
          worktree={worktree}
          worktrees={worktrees}
          local={local}
          open={open === "branch"}
          enabled={!!onMove && !moving}
          onOpen={(next) => setOpen(next ? "branch" : undefined)}
          onPick={move}
        />
      ) : (
        <span className="composer-workspace-item">
          <Icon name="monitor" size={14} />
          <span>Local</span>
        </span>
      )}
      {moving ? (
        <span className="composer-workspace-note" role="status">
          <span className="spinner" aria-hidden="true" />
          Moving the chat
        </span>
      ) : error ? (
        <span className="composer-workspace-note is-error" role="alert" title={error}>
          <Icon name="alert" size={12} />
          {error}
        </span>
      ) : null}
    </div>
  );
}

function BranchButton({
  worktree,
  worktrees,
  local,
  open,
  enabled,
  onOpen,
  onPick,
}: {
  worktree: WorktreeProjection;
  worktrees: readonly WorktreeProjection[];
  local: boolean;
  open: boolean;
  enabled: boolean;
  onOpen(open: boolean): void;
  onPick(place: ChatPlace): void;
}) {
  const { dispatch } = useRuntime();
  const branchState = useBranches(dispatch, worktree.worktreeId, open);
  const branches = branchState.branches;
  const siblings = worktrees.filter(
    (candidate) =>
      candidate.projectId === worktree.projectId &&
      (candidate.status === "ready" || candidate.worktreeId === worktree.worktreeId),
  );
  const inWorktree = new Map(siblings.map((candidate) => [candidate.branch, candidate]));
  const worktreeOptions: Option[] = siblings.map((candidate) => ({
    key: candidate.worktreeId,
    label: candidate.branch,
    detail: isLocal(candidate) ? "Local · your own folder" : `Worktree · ${folderName(candidate.path)}`,
    icon: <Icon name={isLocal(candidate) ? "monitor" : "folderTree"} size={14} />,
    current: candidate.worktreeId === worktree.worktreeId,
    mono: true,
    place: { kind: "worktree", worktreeId: candidate.worktreeId },
  }));
  const names = branches
    ? [...new Set([...branches.local, ...branches.remote.filter((name) => !branches.local.includes(name))])]
    : [];
  const branchOptions: Option[] = names
    .filter((name) => !inWorktree.has(name))
    .map((name) => {
      const elsewhere = branches?.details?.[name]?.worktreePath;
      const remoteOnly = !branches?.local.includes(name);
      return {
        key: `branch:${name}`,
        label: name,
        detail: elsewhere
          ? `Checked out in ${folderName(elsewhere)}`
          : remoteOnly
            ? "On origin. Opens in a new worktree"
            : "Opens in a new worktree",
        icon: <Icon name="branch" size={14} />,
        mono: true,
        ...(elsewhere ? { disabled: true } : {}),
        place: { kind: "branch", projectId: worktree.projectId, branch: name },
      };
    });
  const groups: Group[] = [
    { label: "Worktrees", options: worktreeOptions },
    {
      label: "Branches",
      options: branchOptions,
    },
  ];
  const status = branchState.error ?? (!branches && branchState.loading ? "Reading branches" : undefined);

  return (
    <PlaceButton
      className="is-branch"
      icon={local ? "monitor" : "folderTree"}
      prefix={local ? "Local" : "Worktree"}
      branchIcon
      label={worktree.branch}
      title={worktree.path}
      menuLabel="Move this chat to another branch or worktree"
      open={open}
      enabled={enabled}
      onOpen={onOpen}
      groups={groups}
      search
      status={status}
      onPick={onPick}
    />
  );
}

/** A part of the tab that opens a menu of places, with a filter for long lists such as branches. */
function PlaceButton({
  className,
  icon,
  prefix,
  branchIcon = false,
  label,
  title,
  menuLabel,
  open,
  enabled,
  onOpen,
  groups,
  search = false,
  status,
  onPick,
}: {
  className: string;
  icon: "folder" | "monitor" | "folderTree";
  /** "Local" or "Worktree", shown before the branch. */
  prefix?: string;
  branchIcon?: boolean;
  label: string;
  title: string;
  menuLabel: string;
  open: boolean;
  enabled: boolean;
  onOpen(open: boolean): void;
  groups: Group[];
  search?: boolean;
  status?: string | undefined;
  onPick(place: ChatPlace): void;
}) {
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const placement = useAnchoredPlacement(open, triggerRef, menuRef, {
    prefer: "above",
    align: "start",
    gap: 6,
    edge: 8,
  });

  const close = (returnFocus: boolean) => {
    onOpen(false);
    setQuery("");
    if (returnFocus) triggerRef.current?.focus();
  };

  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (!placed) return;
    const target =
      searchRef.current ??
      menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      menuRef.current?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
    target?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (menuRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const onScroll = (event: Event) => {
      if (scrollMovesAnchor(event, triggerRef.current)) close(false);
    };
    const onLeave = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  });

  const needle = query.trim().toLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      options: needle ? group.options.filter((option) => option.label.toLowerCase().includes(needle)) : group.options,
    }))
    .filter((group) => group.options.length > 0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? []),
    ];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = index <= 0 ? items.at(-1) : items[index - 1];
    else if (event.key === "Enter" && index < 0) next = items[0];
    if (!next) return;
    event.preventDefault();
    if (event.key === "Enter") next.click();
    else {
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
    }
  };

  const content = (
    <>
      <Icon name={icon} size={14} />
      {prefix ? <span className="composer-workspace-prefix">{prefix}</span> : null}
      {branchIcon ? <Icon name="branch" size={14} /> : null}
      <span className="composer-workspace-label">{label}</span>
    </>
  );

  if (!enabled) {
    return (
      <span className={`composer-workspace-item ${className}`} data-tooltip={title}>
        {content}
      </span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-workspace-item is-button ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${menuLabel}. Now: ${prefix ? `${prefix}, ` : ""}${label}`}
        data-tooltip={open ? undefined : `${title}. ${menuLabel}`}
        onClick={() => (open ? close(false) : onOpen(true))}
      >
        {content}
        <Icon name="chevronDown" size={11} className="picker-chevron" />
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the filter and the options.
            <div
              ref={menuRef}
              className="picker-menu place-menu"
              data-side={placement && "top" in placement ? "bottom" : "top"}
              style={
                placement
                  ? { ...placement, maxHeight: Math.min(380, Math.max(160, placement.maxHeight)) }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
              onKeyDown={onKeyDown}
            >
              {search ? (
                <div className="place-menu-search">
                  <Icon name="search" size={13} />
                  <input
                    ref={searchRef}
                    aria-label="Filter branches"
                    placeholder="Filter branches"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              ) : null}
              <div className="picker-list" role="listbox" aria-label={menuLabel}>
                {shown.map((group) => (
                  <div className="picker-group" key={group.label ?? "all"}>
                    {group.label ? <div className="picker-group-label">{group.label}</div> : null}
                    {group.options.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={option.current === true}
                        aria-disabled={option.disabled || undefined}
                        className="picker-option"
                        onClick={() => {
                          if (option.disabled) return;
                          if (option.current) close(true);
                          else if (option.place) onPick(option.place);
                        }}
                      >
                        <span className="picker-option-icon" aria-hidden="true">
                          {option.icon}
                        </span>
                        <span className="picker-option-text">
                          <span className={`picker-option-label${option.mono ? " is-mono" : ""}`}>{option.label}</span>
                          {option.detail ? <span className="picker-option-description">{option.detail}</span> : null}
                        </span>
                        <span className="picker-option-check" aria-hidden="true">
                          {option.current ? <Icon name="check" size={14} /> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
                {shown.length === 0 && !status ? (
                  <p className="place-menu-empty">
                    {needle ? `No branch matches “${query.trim()}”.` : "Nothing else to pick."}
                  </p>
                ) : null}
                {status ? <p className="place-menu-empty">{status}</p> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
