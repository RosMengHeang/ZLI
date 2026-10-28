import {
  HUDDLE_REPLY_LIMIT,
  type HuddlePost,
  type HuddlePostKind,
  type HuddleProjection,
  huddleAgentInfo,
  huddlePostsOf,
  MAX_HUDDLE_TEXT,
  type RuntimeProjection,
  shortHuddleId,
} from "@zli-v2/contracts";
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState } from "../ui/Pane.js";
import { Segmented, type SegmentedOption } from "../ui/Segmented.js";
import { shortcutText } from "../ui/shortcuts.js";
import {
  agentDisplay,
  agentStatusLabel,
  deliveryNotes,
  fitHuddleName,
  HUDDLE_AGENT_DRAG_TYPE,
  heldCount,
  huddleKindLabel,
  liveHuddles,
  type MemberView,
  memberViews,
  PAUSED_MESSAGE,
  recipientsText,
  shortText,
} from "./huddles.js";
import { type HuddleCommands, useHuddleCommands } from "./useHuddleCommands.js";
import "./huddle.css";

const kindHints: Record<HuddlePostKind, string> = {
  ask: "Wants an answer. A chat agent's answer is posted here.",
  assign: "Hands over work. A chat agent's answer is posted here.",
  note: "Shares information. No reply expected.",
};

const kindOptions: SegmentedOption<HuddlePostKind>[] = (["ask", "assign", "note"] as const).map((value) => ({
  value,
  label: huddleKindLabel[value],
  tooltip: kindHints[value],
}));

const REPLY_LIMIT_TEXT = HUDDLE_REPLY_LIMIT.toLocaleString("en-US");

/**
 * The Huddle side pane: one tab per live huddle, its members, decisions, transcript, and a composer.
 * Dropping a tile header on it adds that agent to the huddle in view.
 */
export function HuddlePane({
  projection,
  selectedId,
  onSelect,
  onOpenAgent,
}: {
  projection: RuntimeProjection;
  /** The huddle to show; the first live one when it is missing or archived. */
  selectedId: string | undefined;
  onSelect(huddleId: string): void;
  /** Brings an agent's tile forward, on the chat with that id when it is an earlier one. */
  onOpenAgent(agentId: string): void;
}) {
  const commands = useHuddleCommands();
  const live = liveHuddles(projection);
  const current = live.find((huddle) => huddle.huddleId === selectedId) ?? live[0];
  const baseId = useId();
  const tabId = (huddleId: string) => `${baseId}-tab-${huddleId}`;
  const panelId = (huddleId: string) => `${baseId}-panel-${huddleId}`;
  const tablistRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [createBusy, setCreateBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string>();

  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateError(undefined);
    newButtonRef.current?.focus();
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    setCreateBusy(true);
    const result = await commands.create(newName);
    setCreateBusy(false);
    if ("error" in result) {
      setCreateError(result.error);
      return;
    }
    setCreating(false);
    setNewName("");
    setCreateError(undefined);
    onSelect(result.huddleId);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!current) return;
    const index = live.findIndex((huddle) => huddle.huddleId === current.huddleId);
    let next: HuddleProjection | undefined;
    if (event.key === "ArrowRight") next = live[(index + 1) % live.length];
    else if (event.key === "ArrowLeft") next = live[(index - 1 + live.length) % live.length];
    else if (event.key === "Home") next = live[0];
    else if (event.key === "End") next = live.at(-1);
    if (!next) return;
    event.preventDefault();
    onSelect(next.huddleId);
    const target = next.huddleId;
    requestAnimationFrame(() => document.getElementById(tabId(target))?.focus());
  };

  const carriesAgent = (event: DragEvent) => [...event.dataTransfer.types].includes(HUDDLE_AGENT_DRAG_TYPE);
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!carriesAgent(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropping(false);
  };
  const onDrop = async (event: DragEvent<HTMLElement>) => {
    if (!carriesAgent(event)) return;
    event.preventDefault();
    setDropping(false);
    const agentId = event.dataTransfer.getData(HUDDLE_AGENT_DRAG_TYPE);
    if (!agentId) return;
    setDropError(undefined);
    if (current) {
      if (current.members.some((member) => member.agentId === agentId)) return;
      const error = await commands.run({ type: "huddle.join", huddleId: current.huddleId, agentId });
      if (error) setDropError(error);
      return;
    }
    const label = huddleAgentInfo(projection, agentId)?.label ?? "an agent";
    const result = await commands.create(fitHuddleName(`Huddle with ${label}`), [agentId]);
    if ("error" in result) setDropError(result.error);
    else onSelect(result.huddleId);
  };

  return (
    <section
      className={`tool-pane huddle-pane${dropping ? " is-drop-target" : ""}`}
      aria-label="Huddle"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="pane-header huddle-bar">
        <Icon name="users" size={14} className="huddle-bar-icon" />
        {live.length > 0 ? (
          <div className="huddle-tabs" role="tablist" aria-label="Huddles" ref={tablistRef} onKeyDown={onTabKeyDown}>
            {live.map((huddle) => {
              const selected = huddle.huddleId === current?.huddleId;
              return (
                <button
                  key={huddle.huddleId}
                  id={tabId(huddle.huddleId)}
                  type="button"
                  role="tab"
                  className="huddle-tab"
                  aria-selected={selected}
                  aria-controls={panelId(huddle.huddleId)}
                  tabIndex={selected ? 0 : -1}
                  title={huddle.name}
                  onClick={() => onSelect(huddle.huddleId)}
                >
                  <span className="huddle-tab-name">{huddle.name}</span>
                  {huddle.paused ? <span className="huddle-tab-flag">Paused</span> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <h2 className="huddle-bar-title">Huddle</h2>
        )}
        <Button
          ref={newButtonRef}
          variant="ghost"
          size="sm"
          icon="plus"
          className="huddle-new"
          aria-expanded={creating}
          onClick={() => (creating ? closeCreate() : setCreating(true))}
        >
          New huddle
        </Button>
      </div>
      {creating ? (
        <form className="huddle-create" onSubmit={(event) => void submitCreate(event)}>
          <input
            className="input input-sm"
            aria-label="Huddle name"
            placeholder="Name, such as Release check"
            maxLength={60}
            // biome-ignore lint/a11y/noAutofocus: the person just asked for this field.
            autoFocus
            value={newName}
            aria-invalid={createError ? true : undefined}
            onChange={(event) => {
              setNewName(event.target.value);
              setCreateError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeCreate();
            }}
          />
          <Button type="submit" variant="primary" size="sm" loading={createBusy}>
            Create
          </Button>
          <Button variant="ghost" size="sm" onClick={closeCreate}>
            Cancel
          </Button>
          {createError ? (
            <p className="inline-error huddle-create-error" role="alert">
              {createError}
            </p>
          ) : null}
        </form>
      ) : null}
      {dropError ? (
        <p className="inline-error huddle-drop-error" role="alert">
          {dropError}
        </p>
      ) : null}
      {current ? (
        <HuddleView
          key={current.huddleId}
          projection={projection}
          huddle={current}
          commands={commands}
          panelId={panelId(current.huddleId)}
          tabId={tabId(current.huddleId)}
          onOpenAgent={onOpenAgent}
        />
      ) : (
        <EmptyState
          icon="users"
          title="No huddles yet"
          detail="A huddle is a group conversation between your agents, with you moderating. Press New huddle, then add agents with Add to huddle on a tile or by dragging a tile header here."
        />
      )}
      {dropping ? (
        <div className="huddle-drop-hint" aria-hidden="true">
          {current ? `Drop to add the agent to ${current.name}` : "Drop to start a huddle with this agent"}
        </div>
      ) : null}
    </section>
  );
}

function HuddleView({
  projection,
  huddle,
  commands,
  panelId,
  tabId,
  onOpenAgent,
}: {
  projection: RuntimeProjection;
  huddle: HuddleProjection;
  commands: HuddleCommands;
  panelId: string;
  tabId: string;
  onOpenAgent(agentId: string): void;
}) {
  const posts = useMemo(
    () => [...huddlePostsOf(projection, huddle.huddleId)].sort((left, right) => left.number - right.number),
    [projection, huddle.huddleId],
  );
  const views = useMemo(() => memberViews(projection, huddle), [projection, huddle]);
  const name = (agentId: string) => agentDisplay(projection, views, agentId);
  const decisions = posts.filter((post) => post.decision);
  const postDomId = (postId: string) => `${panelId}-post-${postId}`;
  const numbers = new Map(posts.map((post) => [post.postId, post.number]));

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(huddle.name);
  const [headError, setHeadError] = useState<string>();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [memberError, setMemberError] = useState<string>();
  const [pausedError, setPausedError] = useState<string>();
  const [postErrors, setPostErrors] = useState<Record<string, string>>({});
  const [decisionsOpen, setDecisionsOpen] = useState(true);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);

  const transcriptRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);
  const lastPost = posts.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new or changed last post should scroll.
  useLayoutEffect(() => {
    const list = transcriptRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [posts.length, lastPost?.postId, lastPost?.deliveries]);

  const stopRename = () => {
    setRenaming(false);
    setHeadError(undefined);
    renameButtonRef.current?.focus();
  };
  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    const next = draftName.trim();
    if (next === huddle.name) {
      stopRename();
      return;
    }
    const error = await commands.run({ type: "huddle.rename", huddleId: huddle.huddleId, name: next });
    if (error) setHeadError(error);
    else stopRename();
  };
  const archive = async () => {
    const error = await commands.run({ type: "huddle.archive", huddleId: huddle.huddleId });
    if (error) {
      setHeadError(error);
      setConfirmArchive(false);
    }
  };
  const leave = async (agentId: string) => {
    setMemberError(undefined);
    const error = await commands.run({ type: "huddle.leave", huddleId: huddle.huddleId, agentId });
    if (error) setMemberError(error);
  };
  const resume = async () => {
    setPausedError(undefined);
    const error = await commands.run({ type: "huddle.resume", huddleId: huddle.huddleId });
    if (error) setPausedError(error);
  };
  const decide = async (post: HuddlePost) => {
    setPostErrors(({ [post.postId]: _old, ...rest }) => rest);
    const error = await commands.run({
      type: "huddle.decide",
      huddleId: huddle.huddleId,
      postId: post.postId,
      decision: !post.decision,
    });
    if (error) setPostErrors((current) => ({ ...current, [post.postId]: error }));
  };
  const jumpTo = (postId: string) => {
    const element = document.getElementById(postDomId(postId));
    if (!element) return;
    stickToBottom.current = false;
    element.scrollIntoView?.({ block: "center" });
    element.focus({ preventScroll: true });
  };

  const memberCount = huddle.members.length;
  return (
    <div className="huddle-view" role="tabpanel" id={panelId} aria-labelledby={tabId}>
      <div className="huddle-head">
        {renaming ? (
          <form className="huddle-rename" onSubmit={(event) => void submitRename(event)}>
            <input
              className="input input-sm"
              aria-label="New huddle name"
              maxLength={60}
              // biome-ignore lint/a11y/noAutofocus: the person just asked to rename.
              autoFocus
              value={draftName}
              onChange={(event) => {
                setDraftName(event.target.value);
                setHeadError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                stopRename();
              }}
            />
            <Button type="submit" variant="primary" size="xs">
              Save
            </Button>
            <Button variant="ghost" size="xs" onClick={stopRename}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <h2 className="huddle-name" title={huddle.name}>
              {huddle.name}
            </h2>
            <IconButton
              ref={renameButtonRef}
              label="Rename huddle"
              icon="pencil"
              size="xs"
              iconSize={12}
              onClick={() => {
                setDraftName(huddle.name);
                setRenaming(true);
              }}
            />
          </>
        )}
        <span className="huddle-meta">
          {memberCount === 1 ? "1 agent" : `${memberCount} agents`}
          <span className="huddle-meta-id" title="Agents and the zli CLI can use this id for the huddle">
            {shortHuddleId(huddle.huddleId)}
          </span>
        </span>
        <span className="huddle-spacer" />
        <Button
          ref={archiveButtonRef}
          variant="ghost"
          size="xs"
          aria-expanded={confirmArchive}
          onClick={() => setConfirmArchive((open) => !open)}
        >
          Archive
        </Button>
      </div>
      {confirmArchive ? (
        <fieldset className="huddle-confirm" aria-label="Archive huddle">
          <p>Archive {huddle.name}? Members lose access to it, and messages that have not reached them are dropped.</p>
          <Button variant="danger" size="xs" onClick={() => void archive()}>
            Archive huddle
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setConfirmArchive(false);
              archiveButtonRef.current?.focus();
            }}
          >
            Keep
          </Button>
        </fieldset>
      ) : null}
      {headError ? (
        <p className="inline-error huddle-inline-error" role="alert">
          {headError}
        </p>
      ) : null}
      {memberCount > 0 ? (
        <ul className="huddle-members" aria-label="Members">
          {huddle.members.map((member) => {
            const view: MemberView | undefined = views.get(member.agentId);
            const label = view?.display ?? "A removed agent";
            const held = heldCount(posts, member.agentId);
            const dot = view
              ? member.kind === "terminal"
                ? `status-terminal-${view.status}`
                : `status-${view.status}`
              : "";
            return (
              <li className="huddle-member" key={member.agentId}>
                <span className={`status-dot ${dot}`} aria-hidden="true" />
                <button
                  type="button"
                  className="huddle-member-name"
                  title={`Show ${label}`}
                  onClick={() => onOpenAgent(member.agentId)}
                >
                  {label}
                </button>
                <span className="huddle-member-meta">
                  {member.kind === "terminal" ? "terminal" : "chat"}
                  {view ? `, ${agentStatusLabel(view.status).toLowerCase()}` : ""}
                </span>
                {held > 0 ? <span className="huddle-member-held">{held} held</span> : null}
                <IconButton
                  label={`Remove ${label} from the huddle`}
                  icon="x"
                  size="xs"
                  iconSize={12}
                  onClick={() => void leave(member.agentId)}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="huddle-note">
          No agents in this huddle yet. Use Add to huddle on an agent tile, or drag a tile header onto this panel.
        </p>
      )}
      {memberError ? (
        <p className="inline-error huddle-inline-error" role="alert">
          {memberError}
        </p>
      ) : null}
      {huddle.paused ? (
        <div className="banner banner-warning huddle-paused" role="status">
          <Icon name="pause" size={14} />
          <span className="banner-message">{PAUSED_MESSAGE}</span>
          <Button size="xs" variant="secondary" onClick={() => void resume()}>
            Resume
          </Button>
        </div>
      ) : null}
      {pausedError ? (
        <p className="inline-error huddle-inline-error" role="alert">
          {pausedError}
        </p>
      ) : null}
      {decisions.length > 0 ? (
        <section className="huddle-decisions" aria-label="Decisions">
          <button
            type="button"
            className="huddle-decisions-toggle"
            aria-expanded={decisionsOpen}
            aria-controls={`${panelId}-decisions`}
            onClick={() => setDecisionsOpen((open) => !open)}
          >
            <Icon name="chevronRight" size={11} className="huddle-decisions-chevron" />
            Decisions
            <span className="count">{decisions.length}</span>
          </button>
          {decisionsOpen ? (
            <ul id={`${panelId}-decisions`} className="huddle-decision-list">
              {decisions.map((post) => (
                <li key={post.postId}>
                  <button type="button" className="huddle-decision" onClick={() => jumpTo(post.postId)}>
                    <span className="huddle-post-number">#{post.number}</span>
                    <span className="huddle-decision-text">{shortText(post.text)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <ol
        className="huddle-transcript"
        aria-label="Messages"
        ref={transcriptRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
        }}
      >
        {posts.length === 0 ? (
          <li className="huddle-note huddle-transcript-empty">
            No messages yet. Write to everyone below, or pick one agent in Send to.
          </li>
        ) : (
          posts.map((post) => (
            <HuddlePostItem
              key={post.postId}
              post={post}
              domId={postDomId(post.postId)}
              name={name}
              replyNumber={post.replyTo ? numbers.get(post.replyTo) : undefined}
              error={postErrors[post.postId]}
              onDecide={() => void decide(post)}
              onOpenAgent={onOpenAgent}
              onJump={jumpTo}
            />
          ))
        )}
      </ol>
      <HuddleComposer huddle={huddle} views={views} commands={commands} />
    </div>
  );
}

function HuddlePostItem({
  post,
  domId,
  name,
  replyNumber,
  error,
  onDecide,
  onOpenAgent,
  onJump,
}: {
  post: HuddlePost;
  domId: string;
  name(agentId: string): string;
  replyNumber: number | undefined;
  error: string | undefined;
  onDecide(): void;
  onOpenAgent(agentId: string): void;
  onJump(postId: string): void;
}) {
  const sender = post.from.kind === "person" ? "You" : name(post.from.agentId);
  const senderAgent = post.from.kind === "agent" ? post.from.agentId : undefined;
  const notes = deliveryNotes(post, name);
  const time = new Date(post.createdAt);
  return (
    <li
      id={domId}
      tabIndex={-1}
      className={`huddle-post${post.from.kind === "person" ? " is-person" : ""}${post.decision ? " is-decision" : ""}`}
      aria-label={`Message ${post.number} from ${sender}`}
    >
      <div className="huddle-post-head">
        <span className="huddle-post-number">#{post.number}</span>
        <span className="huddle-post-from">{sender}</span>
        <span className="huddle-post-to">{recipientsText(post.to, name)}</span>
        <Badge className="huddle-kind" tone={post.kind === "note" ? "quiet" : "neutral"}>
          {huddleKindLabel[post.kind]}
        </Badge>
        {post.auto ? <span className="huddle-post-marker">Answer from chat</span> : null}
        {post.decision ? <span className="huddle-post-marker is-decision">Decision</span> : null}
        <span className="huddle-spacer" />
        {Number.isNaN(time.getTime()) ? null : (
          <time className="huddle-post-time" dateTime={post.createdAt}>
            {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        )}
        <IconButton
          label={post.decision ? "Unpin decision" : "Pin as decision"}
          tooltip={post.decision ? "Unpin decision" : "Pin as an agreed decision"}
          icon="pin"
          size="xs"
          iconSize={12}
          className={post.decision ? "huddle-pin is-on" : "huddle-pin"}
          onClick={onDecide}
        />
      </div>
      {post.replyTo && replyNumber !== undefined ? (
        <button type="button" className="huddle-post-reply" onClick={() => post.replyTo && onJump(post.replyTo)}>
          Reply to #{replyNumber}
        </button>
      ) : null}
      <p className="huddle-post-text">{post.text}</p>
      {post.cut ? (
        <p className="huddle-post-cut">
          <span>Cut at {REPLY_LIMIT_TEXT} characters. The full answer is in the agent's chat.</span>
          {senderAgent ? (
            <Button variant="ghost" size="xs" icon="message" onClick={() => onOpenAgent(senderAgent)}>
              Open chat
            </Button>
          ) : null}
        </p>
      ) : null}
      {notes.length > 0 ? (
        <ul className="huddle-post-deliveries" aria-label="Delivery">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="inline-error huddle-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function HuddleComposer({
  huddle,
  views,
  commands,
}: {
  huddle: HuddleProjection;
  views: ReadonlyMap<string, MemberView>;
  commands: HuddleCommands;
}) {
  const [to, setTo] = useState("everyone");
  const [kind, setKind] = useState<HuddlePostKind>("ask");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const hintId = useId();
  const noMembers = huddle.members.length === 0;
  const target = to === "everyone" || huddle.members.some((member) => member.agentId === to) ? to : "everyone";
  useEffect(() => {
    if (target !== to) setTo(target);
  }, [target, to]);

  const options = [
    { value: "everyone", label: "Everyone" },
    ...huddle.members.map((member) => ({
      value: member.agentId,
      label: views.get(member.agentId)?.display ?? "A removed agent",
    })),
  ];

  const send = async () => {
    const body = text.trim();
    if (noMembers || !body || sending) return;
    setSending(true);
    setError(undefined);
    const failure = await commands.run({
      type: "huddle.post",
      huddleId: huddle.huddleId,
      postId: crypto.randomUUID(),
      to: target === "everyone" ? "everyone" : [target],
      kind,
      text: body,
    });
    setSending(false);
    if (failure) setError(failure);
    else setText("");
  };

  return (
    <form
      className="huddle-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="huddle-composer-row">
        <Select label="Send to" value={target} options={options} onChange={setTo} disabled={noMembers} />
        <Segmented<HuddlePostKind> label="Message kind" value={kind} options={kindOptions} onChange={setKind} />
      </div>
      <textarea
        className="textarea huddle-composer-input"
        aria-label="Message to the huddle"
        aria-describedby={hintId}
        rows={3}
        maxLength={MAX_HUDDLE_TEXT}
        placeholder={
          target === "everyone" ? "Write to everyone in the huddle" : `Write to ${views.get(target)?.display}`
        }
        disabled={noMembers}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="huddle-composer-foot">
        <span className="huddle-composer-hint" id={hintId}>
          {noMembers
            ? "Add an agent to the huddle first."
            : `${huddleKindLabel[kind]} ${kindHints[kind].charAt(0).toLowerCase()}${kindHints[kind].slice(1)} ${shortcutText("Mod+Enter")} sends.`}
        </span>
        <Button type="submit" variant="primary" size="sm" loading={sending} disabled={noMembers || !text.trim()}>
          Send
        </Button>
      </div>
      {error ? (
        <p className="inline-error huddle-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
