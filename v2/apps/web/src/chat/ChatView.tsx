import {
  agentNameKey,
  isListedThreadStatus,
  type PermissionMode,
  type RuntimeProjection,
  type ThreadActivityProjection,
  type ThreadAttachment,
  type ThreadCheckpoint,
  type ThreadId,
  type ThreadMessageProjection,
  type ThreadProjection,
  type ThreadQueuedMessage,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { agentUsable, chatAgentStatus } from "../agent/agentStatus.js";
import { isSelectableProvider, listedDiscoveries, providerDisplayName } from "../agent/providers.js";
import { type FileLinks, useFileIndexContext, useFileLinks } from "../files/FileIndex.js";
import { useKnownPlanLimits } from "../limits/limits.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { entriesForThread, entriesForThreads, entriesInOrder, shallowArrayEqual } from "../runtime/runtimeStore.js";
import type { RunAgent, RunStart } from "../sessions/bestOf.js";
import { takeoverContext } from "../sessions/handoff.js";
import type { ChatPlace } from "../sessions/launch.js";
import { buildTimeline, conversationThreads, type TimelineItem } from "../sessions/sessions.js";
import { useAppSettings } from "../settings/appSettings.js";
import { useShortcut } from "../shell/keybindings.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { type Buddy, buddyName } from "../teammates/buddies.js";
import { useChatBuddy } from "../teammates/chatBuddies.js";
import {
  buddyGuests,
  defaultBuddy,
  freeAgentName,
  freeBuddy,
  leadingMentions,
  roomBuddies,
  teammateNamed,
} from "../teammates/teammates.js";
import { Button, IconButton } from "../ui/Button.js";
import { Collapse } from "../ui/Collapse.js";
import { Icon } from "../ui/Icon.js";
import { Menu, type MenuItem, type MenuRequest } from "../ui/Menu.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { latestContext } from "../usage/usage.js";
import { AgentUnavailableNotice } from "./AgentUnavailableNotice.js";
import { accountChoices, accountPlan, otherAgents } from "./agentModels.js";
import { splitAttachedContext } from "./attachedContext.js";
import { fileName, splitAttachedFiles } from "./attachedFiles.js";
import type { BestOfAgentOption } from "./BestOfPopover.js";
import {
  ContinueRow,
  FollowUps,
  followUpsIn,
  type PlanApprovalAction,
  PlanCard,
  PullRequestStrip,
  ReviewCard,
  reviewFindings,
} from "./ChatExtras.js";
import { ChatImageScope } from "./ChatImage.js";
import { AssistantMessage, UserMessage, WorkingStatus } from "./ChatMessages.js";
import { CompactionDivider, type CompactionState } from "./CompactionDivider.js";
import { Composer, type ComposerAttachment, type ComposerBestOf } from "./Composer.js";
import { ConnectorCard } from "./ConnectorCard.js";
import { clearCodeReferences, removeCodeReference, useCodeReferences } from "./codeReferences.js";
import { type CompactAction, CompactActionContext, publishCompactAction } from "./compactAction.js";
import {
  type Compaction,
  compactFocus,
  compactionMode,
  compactionRequestId,
  compactRequestText,
  DEFAULT_COMPACT_FOCUS,
  endsWithCompaction,
  foldCompactions,
  isCompactCommand,
  isCompactionNotice,
  isCompactionRequest,
  latestSummary,
  nativeTokensSaved,
  shouldAutoCompact,
  summaryContext,
  summaryTokensSaved,
  withKnownWindow,
} from "./compaction.js";
import type { ComposerCommand, MentionOption } from "./composerTriggers.js";
import { DockSlot, firstDockItem } from "./DockSlot.js";
import { type GuestCardAction, GuestWorkCard } from "./GuestWorkCard.js";
import { type GuestMode, guestBranchName, guestModeHint, guestModeOf } from "./guestWork.js";
import { liveStepLabel } from "./liveStatus.js";
import { type PendingRequest, RequestPager } from "./RequestCard.js";
import { RoomBar, RoomLive, type RoomPerson, RoomSpeaker } from "./RoomParts.js";
import { fastFor, reasoningLevels } from "./reasoning.js";
import { loadReplaced, type ReplacedRange, replacedIndexes, replaceNote, saveReplaced } from "./replaced.js";
import { mergeRoomTimeline, missedBy, roomBrief, roomGuests, roomHelpers, runningStep } from "./room.js";
import { onSideQuestionRequest, SideChat, sideQuestionContext, sideQuestionUpdate } from "./SideChat.js";
import { type Source, turnSources } from "./Sources.js";
import { ErrorText } from "./StackTrace.js";
import { isSideChat } from "./sideChats.js";
import { isSwitchNotice, switchNotice } from "./switchNotice.js";
import { TurnChanges } from "./TurnChanges.js";
import { TurnRail } from "./TurnRail.js";
import { groupTurns, trailSummary, workedFor } from "./turns.js";
import { UsageLimitNote } from "./UsageLimitNote.js";
import { useDockHeight } from "./useDockHeight.js";
import { ChangedFiles, WorkSteps } from "./WorkLog.js";
import { WorkspaceBar } from "./WorkspaceBar.js";
import "./chat.css";

export function ChatView({
  projection,
  thread,
  worktree,
  onOpenDiff,
  onRestart,
  onSwitchAgent,
  onMoveChat,
  onAddFolder,
  onOpenConnectors,
  onStartRuns,
  onBringIn,
  onDiscardGuest,
  onOpenAgent,
  onBranch,
  onNewChatWithPrompt,
  onAskAside,
  onCloseAside,
  active,
}: {
  projection: RuntimeProjection;
  thread: ThreadProjection;
  worktree: WorktreeProjection | undefined;
  onOpenDiff(path?: string): void;
  onRestart(): void;
  /**
   * Starts this chat over with another agent, before anything was sent. Absent where the tile cannot
   * start agents, such as a scratch chat.
   */
  onSwitchAgent?: ((provider: string, model: string | undefined) => Promise<string | undefined>) | undefined;
  /** Moves the chat to another folder, worktree, or branch before its first message. */
  onMoveChat?: ((place: ChatPlace) => Promise<string | undefined>) | undefined;
  /**
   * Adds a folder as a project (the given one, or else one picked in the folder picker), for the project menu
   * before the first message.
   */
  onAddFolder?: ((path?: string) => Promise<string | undefined>) | undefined;
  /** Opens Settings at a connector, a catalog id or a server name. */
  onOpenConnectors?: ((connectorId?: string) => void) | undefined;
  /** Starts best-of runs from this chat. Absent where runs cannot start, such as a scratch chat. */
  onStartRuns?: ((request: StartRunsRequest) => Promise<string | undefined>) | undefined;
  /** Starts another agent inside this chat. Absent where agents cannot start from here, such as a scratch chat. */
  onBringIn?: ((request: GuestRequest) => Promise<{ threadId: string } | { error: string }>) | undefined;
  /** Lets an agent that worked on its own copy go: stops it and removes its worktree and branch. */
  onDiscardGuest?: ((threadId: string) => Promise<void>) | undefined;
  /** Shows an agent's own chat or terminal, found by its thread or terminal id. */
  onOpenAgent?: ((agentId: string) => void) | undefined;
  /** Starts a new chat that carries this conversation up to a reply. */
  onBranch?: ((branch: { from: string; context: string }) => void) | undefined;
  /** Opens a new chat in this project with the task already typed. */
  onNewChatWithPrompt?: ((text: string) => void) | undefined;
  /** Starts a side question: a short read-only chat that reads this conversation and never writes to it. */
  onAskAside?:
    | ((question: string, context: string | undefined) => Promise<{ threadId: string } | { error: string }>)
    | undefined;
  /** Ends a side question and removes its chat. */
  onCloseAside?: ((threadId: string) => void) | undefined;
  active?: boolean;
}) {
  const { bridge, dispatch } = useRuntime();
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<string | undefined>(thread.model);
  const threadMode = thread.permissionMode ?? "full-access";
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(threadMode);
  const permissionSwitch = thread.capabilities.permissionSwitch === "in-session";
  useEffect(() => setPermissionMode(threadMode), [threadMode]);
  const references = useCodeReferences(thread.threadId);
  const logRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useDockHeight(viewRef, dockRef, logRef);
  const stickToBottom = useRef(true);
  /** Scrolled up from the end of the chat, which offers the way back down. */
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const displayName = thread.name ?? providerDisplayName(thread.provider, projection.providers);
  const discovery = projection.providers?.find((entry) => entry.provider === thread.provider);
  const models = discovery?.status === "found" ? discovery.models : undefined;
  const [chosenReasoning, setChosenReasoning] = useState<string>();
  const reasoning = reasoningLevels(models, model, thread.capabilities, discovery);
  // A level the new model does not take falls back to the default instead of failing the turn.
  // A new chat starts on Low, the quickest level, when the model offers it; picking another level holds for the chat.
  const startingReasoning = reasoning.levels.find((level) => level.toLowerCase() === "low");
  const reasoningEffort =
    (chosenReasoning && reasoning.levels.includes(chosenReasoning) ? chosenReasoning : undefined) ?? startingReasoning;
  // Fast holds for the chat while the picked model offers it; a model without it simply runs at standard speed.
  const [fastOn, setFastOn] = useState(false);
  const fastValue = fastFor(models, model);
  const fast = fastOn ? fastValue : undefined;
  // The projection passed in skips chat-only updates, so this thread's chat state is read from the
  // store. Each selector returns the same value while this thread is unchanged, even when another
  // thread is streaming.
  const threadId = thread.threadId;
  const messages = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThread(value?.messages, threadId), [threadId]),
    shallowArrayEqual,
  );
  const activities = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThread(value?.activities, threadId), [threadId]),
    shallowArrayEqual,
  );
  const hostRequests = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) =>
        (value?.requests ?? []).filter((candidate) => candidate.threadId === threadId),
      [threadId],
    ),
    shallowArrayEqual,
  );
  const request = hostRequests[0];
  const waitingCount = hostRequests.length;
  const queued = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => entriesForThread(value?.queuedMessages, threadId),
      [threadId],
    ),
    shallowArrayEqual,
  );
  const usage = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThread(value?.usage, threadId), [threadId]),
    shallowArrayEqual,
  );
  // An agent that leaves its window out of its report gets the model's known window, so the ring can fill.
  const context = useMemo(
    () => withKnownWindow(latestContext(usage), model ?? thread.model),
    [usage, model, thread.model],
  );
  // A chat that moved to another agent or model is one conversation across the threads it went through.
  const chain = useMemo(() => conversationThreads(thread, projection.threads), [thread, projection.threads]);
  const earlierKey = chain
    .slice(0, -1)
    .map((entry) => entry.threadId)
    .join(" ");
  // Every turn of the conversation keeps its file changes and its point to try again from, whichever
  // agent ran it.
  const chainKey = earlierKey ? `${earlierKey} ${threadId}` : threadId;
  // When each turn of the conversation ran, for "Worked for" and for the timer of the turn in progress.
  const turnTimes = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.turns, chainKey), [chainKey]),
    shallowArrayEqual,
  );
  // The team's buddies, which the person can bring into this chat to talk in it, so the chat reads as one room.
  const teammates = useMemo(() => buddyGuests(projection), [projection]);
  // The chat's own buddy, the same one the sidebar shows for it.
  const hostBuddy = useChatBuddy(thread.sessionId ?? thread.threadId);
  const chainIds = useMemo(() => new Set(chain.map((entry) => entry.threadId)), [chain]);
  const guests = useMemo(() => roomGuests(chainIds, projection.threads), [chainIds, projection.threads]);
  const guestIds = useMemo(() => new Set(guests.map((guest) => guest.threadId)), [guests]);
  const guestKey = guests.map((guest) => guest.threadId).join(" ");
  const roomKey = guestKey ? `${chainKey} ${guestKey}` : chainKey;
  const roomMessages = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesInOrder(value?.messages, roomKey), [roomKey]),
    shallowArrayEqual,
  );
  const guestActivities = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.activities, guestKey), [guestKey]),
    shallowArrayEqual,
  );
  const helpers = useMemo(
    () => roomHelpers(new Set([...chainIds, ...guestIds]), projection.threads, projection.terminals),
    [chainIds, guestIds, projection.threads, projection.terminals],
  );
  const helperKey = helpers.flatMap((helper) => (helper.kind === "chat" ? [helper.id] : [])).join(" ");
  const helperActivities = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.activities, helperKey), [helperKey]),
    shallowArrayEqual,
  );
  const guestRequests = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) =>
        guestKey ? (value?.requests ?? []).filter((candidate) => guestKey.split(" ").includes(candidate.threadId)) : [],
      [guestKey],
    ),
    shallowArrayEqual,
  );
  const checkpoints = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.checkpoints, roomKey), [roomKey]),
    shallowArrayEqual,
  );
  const earlierMessages = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.messages, earlierKey), [earlierKey]),
    shallowArrayEqual,
  );
  const earlierActivities = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => entriesForThreads(value?.activities, earlierKey),
      [earlierKey],
    ),
    shallowArrayEqual,
  );
  const previousTimeline = useRef<readonly TimelineItem[]>([]);
  const ownTimeline = useMemo(() => {
    const items: TimelineItem[] = [];
    let before: (typeof chain)[number] | undefined;
    let beforeCompacted = false;
    for (const entry of chain) {
      const own = entry.threadId === threadId;
      const written = own ? messages : earlierMessages.filter((message) => message.threadId === entry.threadId);
      const done = own ? activities : earlierActivities.filter((activity) => activity.threadId === entry.threadId);
      // A thread nobody wrote in adds nothing to read, so the notice spans it.
      if (!own && written.length === 0 && done.length === 0) continue;
      // A thread that ended on its compaction summary already has its divider; a switch notice would repeat it.
      if (before && !beforeCompacted)
        items.push({ kind: "message", message: switchNotice(before, entry, projection.providers) });
      items.push(...buildTimeline(foldCompactions(written).messages, done, previousTimeline.current));
      before = entry;
      beforeCompacted = endsWithCompaction(written) && latestSummary(written) !== undefined;
    }
    return items;
  }, [chain, threadId, messages, activities, earlierMessages, earlierActivities, projection.providers]);
  useEffect(() => {
    previousTimeline.current = ownTimeline;
  }, [ownTimeline]);
  const timeline = useMemo(() => {
    if (guests.length === 0) return ownTimeline;
    const order = new Map(roomMessages.map((message, index) => [message.messageId, index]));
    const guestSaid = roomMessages.filter((message) => guestIds.has(message.threadId) && message.role !== "system");
    return mergeRoomTimeline(ownTimeline, guestSaid, order);
  }, [ownTimeline, guests.length, roomMessages, guestIds]);
  const turns = useMemo(() => groupTurns(timeline), [timeline]);
  // A long chat opens with its newest rows drawn; scrolling up draws older ones. Drawing a thousand messages
  // through Markdown at once made long chats slow to open.
  const [rowWindow, setRowWindow] = useState(() => ({ threadId: thread.threadId, count: ROW_WINDOW }));
  const shownRows = rowWindow.threadId === thread.threadId ? rowWindow.count : ROW_WINDOW;
  const hiddenRows = Math.max(0, turns.rows.length - shownRows);
  const visibleRows = hiddenRows > 0 ? turns.rows.slice(hiddenRows) : turns.rows;
  /** Distance from the bottom before older rows were added, so the view stays on the same message. */
  const keepFromBottom = useRef<number | undefined>(undefined);
  const showEarlier = useCallback(() => {
    const log = logRef.current;
    if (log) keepFromBottom.current = log.scrollHeight - log.scrollTop;
    setRowWindow((current) => ({
      threadId: thread.threadId,
      count: (current.threadId === thread.threadId ? current.count : ROW_WINDOW) + ROW_WINDOW,
    }));
  }, [thread.threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the added rows are drawn.
  useLayoutEffect(() => {
    const log = logRef.current;
    const kept = keepFromBottom.current;
    if (!log || kept === undefined) return;
    keepFromBottom.current = undefined;
    log.scrollTop = log.scrollHeight - kept;
  }, [shownRows]);
  // Each compaction in the chat, how it went, and about how much it freed, for the divider in its place.
  const chainUsage = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.usage, chainKey), [chainKey]),
    shallowArrayEqual,
  );
  const threadStatus = thread.status;
  // The summary that could not move to a fresh session, so its divider stops waiting and Compact works again.
  const [handoffFailed, setHandoffFailed] = useState<string>();
  const compactions = useMemo(() => {
    const all = [...earlierMessages, ...messages];
    const views = new Map<string, { compaction: Compaction; state: CompactionState; saved: number | undefined }>();
    for (const compaction of foldCompactions(all).compactions.values()) {
      const request = all.find((message) => message.messageId === compaction.requestId);
      if (!request) continue;
      const said = all.filter((message) => message.threadId === request.threadId);
      const usageOf = chainUsage.filter((record) => record.threadId === request.threadId);
      const own = request.threadId === threadId;
      const running = own && (threadStatus === "working" || threadStatus === "starting");
      const sentAfter = said
        .slice(said.indexOf(request) + 1)
        .some((message) => (message.role === "user" || message.role === "agent") && !isCompactionRequest(message));
      if (compaction.mode === "native") {
        views.set(compaction.requestId, {
          compaction,
          state: running && !sentAfter ? "compacting" : "done",
          saved: nativeTokensSaved({
            requestId: request.messageId,
            messages: said,
            turns: turnTimes.filter((turn) => turn.threadId === request.threadId),
            usage: usageOf,
          }),
        });
        continue;
      }
      const next = chain[chain.findIndex((entry) => entry.threadId === request.threadId) + 1];
      const before = usageOf.findLast((record) => record.usage.contextTokens !== undefined)?.usage.contextTokens;
      const fresh = next
        ? chainUsage.find((record) => record.threadId === next.threadId && record.usage.contextTokens !== undefined)
            ?.usage.contextTokens
        : undefined;
      // The summary way finishes once the chat carries on in its fresh session.
      const state: CompactionState = next
        ? "done"
        : running ||
            (own &&
              threadStatus === "idle" &&
              compaction.summary &&
              !sentAfter &&
              handoffFailed !== compaction.requestId)
          ? "compacting"
          : "stopped";
      views.set(compaction.requestId, {
        compaction,
        state,
        saved: summaryTokensSaved({ before, freshContext: fresh, summary: compaction.summary }),
      });
    }
    return views;
  }, [earlierMessages, messages, chainUsage, chain, threadId, threadStatus, turnTimes, handoffFailed]);
  const worked = useMemo(() => {
    const labels = new Map<string, string>();
    for (const turn of turnTimes) {
      const label = workedFor(turn);
      if (label) labels.set(turn.turnId, label);
    }
    return labels;
  }, [turnTimes]);
  // A folded turn says how long it worked on its fold, so its reply does not say it again.
  const foldedTurns = useMemo(() => {
    const folded = new Set<string>();
    for (const row of turns.rows) {
      const turnId = row.kind === "fold" ? row.activities[0]?.turnId : undefined;
      if (turnId) folded.add(turnId);
    }
    return folded;
  }, [turns.rows]);
  const sourcesByTurn = useMemo(() => {
    const byTurn = new Map<string, ThreadActivityProjection[]>();
    for (const item of timeline) {
      if (item.kind === "work") byTurn.set(item.turnId, [...(byTurn.get(item.turnId) ?? []), ...item.activities]);
    }
    const sources = new Map<string, Source[]>();
    for (const [turnId, list] of byTurn) {
      const found = turnSources(list);
      if (found.length > 0) sources.set(turnId, found);
    }
    return sources;
  }, [timeline]);
  const fileLinks = useFileLinks(worktree?.worktreeId, messages.length);
  const latestOpenDiff = useRef(onOpenDiff);
  useLayoutEffect(() => {
    latestOpenDiff.current = onOpenDiff;
  });
  const openDiff = useCallback((...args: [path?: string]) => latestOpenDiff.current(...args), []);
  const latestLinks = useRef(fileLinks);
  latestLinks.current = fileLinks;
  const openFile = useCallback((path: string) => latestLinks.current?.open({ path }), []);
  const ended = thread.status === "stopped" || thread.status === "failed";
  // Files the agent just made must open from the reply that names them, so the file list reloads as
  // steps finish and once more, at once, when the turn ends.
  const fileIndex = useFileIndexContext();
  const reloadFiles = fileIndex?.refresh;
  const linkWorktreeId = worktree?.worktreeId;
  const turnRunning = thread.status === "working";
  const stepCount = activities.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a finished step signals that files may have changed.
  useEffect(() => {
    if (!reloadFiles || !linkWorktreeId) return;
    void reloadFiles(linkWorktreeId, turnRunning ? 3_000 : 0).catch(() => undefined);
  }, [reloadFiles, linkWorktreeId, turnRunning, stepCount]);
  // The agent's own conversation id lets the next message start it again where it left off.
  const resumable = ended && Boolean(thread.providerSessionId) && worktree !== undefined;
  const canSend = !ended || resumable;
  const working = thread.status === "working" || thread.status === "waiting";
  const busy = working || queued.length > 0;
  // A chat opens before its agent has started. Messages sent meanwhile read as sent, in the conversation,
  // and go out the moment the agent is up, so the start-up never looks like a queue.
  const startingUp = thread.status === "starting";
  const earlyMessages = useMemo(
    () =>
      startingUp
        ? queued.map(
            (entry): ThreadMessageProjection => ({
              messageId: entry.queueId,
              threadId: thread.threadId,
              role: "user",
              text: entry.text,
              ...(entry.attachments ? { attachments: entry.attachments } : {}),
            }),
          )
        : [],
    [startingUp, queued, thread.threadId],
  );
  const peers = useMemo(() => {
    if (!worktree) return [];
    return projection.threads.filter((candidate) => {
      if (candidate.threadId === thread.threadId || candidate.joins === thread.threadId) return false;
      if (candidate.status === "stopped" || candidate.status === "failed") return false;
      if (candidate.sessionId && isSideChat(candidate.sessionId)) return false;
      const peerWorktree = projection.worktrees.find((item) => item.worktreeId === candidate.worktreeId);
      return peerWorktree?.projectId === worktree.projectId;
    });
  }, [projection.threads, projection.worktrees, thread.threadId, worktree]);
  const placedCheckpoints = useMemo(() => placeCheckpoints(timeline, checkpoints), [timeline, checkpoints]);
  const worktreeBusy = projection.threads.some(
    (candidate) =>
      candidate.worktreeId === thread.worktreeId && (candidate.status === "working" || candidate.status === "waiting"),
  );
  const restoreBlocked = worktreeBusy ? "Wait for the agents in this worktree to finish their turns" : undefined;
  const turnChanges = (checkpoint: ThreadCheckpoint) => (
    <TurnChanges
      key={checkpoint.checkpointId}
      checkpoint={checkpoint}
      worktreeId={thread.worktreeId}
      displayName={displayName}
      branch={worktree?.branch ?? "this worktree"}
      restoreBlocked={restoreBlocked}
      onOpenFile={fileLinks ? openFile : undefined}
    />
  );

  useEffect(() => {
    const log = logRef.current;
    if (!log || !stickToBottom.current) return;
    log.scrollTop = log.scrollHeight;
  });

  // A message that arrives while the person reads further up is announced on the way back down.
  const messageCount = messages.length;
  const seenCount = useRef(messageCount);
  useEffect(() => {
    if (messageCount > seenCount.current && !stickToBottom.current) setUnseen(true);
    seenCount.current = messageCount;
  }, [messageCount]);

  const jumpToLatest = () => {
    const log = logRef.current;
    if (!log) return;
    stickToBottom.current = true;
    setUnseen(false);
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  };
  const toggleFold = (key: string) =>
    setOpenFolds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const sendToHost = async (
    text: string,
    attachments: readonly (ComposerAttachment | ThreadAttachment)[],
    options: { permissionMode?: PermissionMode; note?: string } = {},
  ): Promise<boolean> => {
    setError(undefined);
    // The first message to an agent that took the chat over brings it the conversation so far. The chat
    // shows the message alone.
    const firstHere =
      earlierMessages.length > 0 && queued.length === 0 && !messages.some((message) => message.role === "user");
    // After a compaction the fresh session reads the summary instead of the full conversation.
    const compacted = firstHere ? latestSummary(earlierMessages) : undefined;
    const takeover = compacted
      ? summaryContext({
          ...compacted,
          branch: worktree?.branch ?? "the current branch",
          nameOf: (message) => {
            const writer = chain.find((entry) => entry.threadId === message.threadId);
            return writer ? (writer.name ?? providerDisplayName(writer.provider, projection.providers)) : "Agent";
          },
        })
      : firstHere
        ? takeoverContext({
            branch: worktree?.branch ?? "the current branch",
            messages: earlierMessages,
            nameOf: (message) => {
              const writer = chain.find((entry) => entry.threadId === message.threadId);
              return writer ? (writer.name ?? providerDisplayName(writer.provider, projection.providers)) : "Agent";
            },
          })
        : undefined;
    // With other agents in the chat, the chat's own agent also reads what they said since its last reply.
    const missed = !takeover && guests.length > 0 ? missedBy(chainIds, roomMessages) : [];
    const roomContext =
      takeover ??
      (missed.length > 0
        ? roomBrief({
            name: displayName,
            joining: false,
            others: guests.map(nameOfThread),
            branch: worktree?.branch ?? "the current branch",
            missed,
            nameOf: speakerName,
          })
        : undefined);
    const brief = [options.note, roomContext].filter(Boolean).join("\n\n") || undefined;
    const mode = options.permissionMode ?? permissionMode;
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "thread.queue",
          queueId: makeCommandId(),
          threadId: thread.threadId,
          text,
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(fast ? { fast } : {}),
          ...(permissionSwitch && mode !== threadMode ? { permissionMode: mode } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(brief ? { context: brief } : {}),
        },
      });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      stickToBottom.current = true;
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
      return false;
    }
  };

  const run = async (command: Record<string, unknown>) => {
    setError(undefined);
    const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
    if (response?.accepted === false) setError(response.error.message);
  };

  const stopTurn = () =>
    void run({
      type: "thread.interrupt",
      threadId: thread.threadId,
      ...(thread.activeTurnId ? { turnId: thread.activeTurnId } : {}),
    });

  const runAgents = useMemo(
    (): BestOfAgentOption[] =>
      listedDiscoveries(projection.providers).flatMap((entry) =>
        entry.status === "found" ? [{ provider: entry.provider, name: entry.displayName, models: entry.models }] : [],
      ),
    [projection.providers],
  );
  // Runs each get their own worktree, which a folder without Git cannot have.
  const project = projection.projects.find((candidate) => candidate.projectId === worktree?.projectId);
  const gitProject = project?.git !== false;
  const bestOf: ComposerBestOf | undefined =
    onStartRuns && worktree?.status === "ready" && gitProject
      ? {
          agents: runAgents,
          current: { provider: thread.provider, ...(model ? { model } : {}) },
          onStart: ({ text, runs }) =>
            onStartRuns({
              prompt: text,
              runs,
              from: { kind: "worktree", worktreeId: thread.worktreeId },
              permissionMode,
            }),
        }
      : undefined;

  const [dismissedConnectors, setDismissedConnectors] = useState<ReadonlySet<string>>(() => new Set());
  const connectorActivity = useMemo(() => {
    const latest = activities.findLast((activity) => activity.connector !== undefined);
    return latest && !dismissedConnectors.has(latest.activityId) ? latest : undefined;
  }, [activities, dismissedConnectors]);
  const newChatForConnector = async () => {
    // The agent loads its MCP servers when it starts, so a new connector needs a fresh chat.
    if (!ended) await run({ type: "thread.stop", threadId: thread.threadId });
    onRestart();
  };

  const step = useMemo(() => (working ? currentStep(ownTimeline) : undefined), [working, ownTimeline]);
  // The line under the chat says what the agent does now, worked out the same way as the sidebar and room rows.
  // A running tool step already shimmers in the list, so the line itself stays still then.
  const toolRunning = step !== undefined && step.kind !== "reasoning";
  const liveLabel = thread.status === "waiting" ? `${displayName} is waiting for you` : liveStepLabel(step);
  // The timer counts from when the turn started on the server, so it stays right after a reload.
  const turnStartedAt = working
    ? turnTimes.findLast((turn) => turn.threadId === threadId && !turn.completedAt)?.startedAt
    : undefined;
  const visibleError = error;
  // Until the first message, the chat is not tied to its agent yet, so the model list offers every agent.
  const fresh = messages.length === 0 && earlierMessages.length === 0 && queued.length === 0 && !ended;
  // A started chat can move too: the pick opens a new chat in the tile that carries the conversation so far.
  // Not while the agent works, so a click in the model list never cuts off a reply.
  const switchable = onSwitchAgent !== undefined && !working && queued.length === 0;
  const modelLocked = thread.capabilities.modelSwitch === "unsupported" && messages.length > 0;
  const readings = useKnownPlanLimits();
  // An agent the plan readings say is signed out is left out as well. Accounts are not offered here:
  // a switch carries the conversation to the agent's default login.
  const others = useMemo(
    () =>
      switchable
        ? accountChoices(otherAgents(projection.providers, thread.provider), {
            accounts: [],
            readings,
            providers: projection.providers,
            current: { provider: thread.provider, accountId: undefined },
          })
        : [],
    [switchable, projection.providers, thread.provider, readings],
  );
  const agentName = providerDisplayName(thread.provider, projection.providers);
  const accountStatus = chatAgentStatus(discovery, thread.accountId);
  // Shown on the composer, which keeps sending off until the agent can run again.
  const unavailable = agentUsable(accountStatus) ? undefined : (
    <AgentUnavailableNotice name={agentName} provider={thread.provider} status={accountStatus} />
  );
  const switchAgent = (provider: string, next: string | undefined) => {
    setError(undefined);
    void onSwitchAgent?.(provider, next).then((failure) => {
      if (failure) setError(failure);
    });
  };

  // The room: who is in this chat, the buddy each one wears, and how the person calls them.
  function nameOfThread(entry: ThreadProjection): string {
    return entry.name ?? providerDisplayName(entry.provider, projection.providers);
  }
  const buddies = useMemo(
    () =>
      roomBuddies(
        [
          {
            id: thread.threadId,
            provider: thread.provider,
            name: thread.name,
            buddy: hostBuddy,
          },
          ...guests.map((guest) => ({ id: guest.threadId, provider: guest.provider, name: guest.name })),
          ...chain.slice(0, -1).map((entry) => ({ id: entry.threadId, provider: entry.provider, name: entry.name })),
          ...helpers.map((helper) =>
            helper.kind === "chat"
              ? { id: helper.id, provider: helper.thread.provider, name: helper.thread.name }
              : { id: helper.id, provider: helper.terminal.agent?.provider ?? "", name: helper.terminal.name },
          ),
        ],
        teammates,
      ),
    [thread, guests, chain, helpers, teammates, hostBuddy],
  );
  const buddyOf = (id: string, provider: string): Buddy => buddies.get(id) ?? defaultBuddy(provider);
  const people = useMemo((): RoomPerson[] => {
    const providerName = (provider: string) => providerDisplayName(provider, projection.providers);
    const stepOf = (list: readonly ThreadActivityProjection[], id: string) =>
      runningStep(list.filter((activity) => activity.threadId === id));
    return [
      {
        id: thread.threadId,
        name: displayName,
        agent: providerName(thread.provider),
        provider: thread.provider,
        buddy: buddies.get(thread.threadId) ?? defaultBuddy(thread.provider),
        status: thread.status,
        step,
        role: "host",
      },
      ...guests.map(
        (guest): RoomPerson => ({
          id: guest.threadId,
          name: guest.name ?? providerName(guest.provider),
          agent: providerName(guest.provider),
          provider: guest.provider,
          buddy: buddies.get(guest.threadId) ?? defaultBuddy(guest.provider),
          status: guest.status,
          step: guest.status === "working" ? stepOf(guestActivities, guest.threadId) : undefined,
          role: "guest",
          mode: guestModeOf(guest, thread.worktreeId),
        }),
      ),
      ...helpers.map((helper): RoomPerson => {
        if (helper.kind === "chat") {
          return {
            id: helper.id,
            name: helper.thread.name ?? providerName(helper.thread.provider),
            agent: providerName(helper.thread.provider),
            provider: helper.thread.provider,
            buddy: buddies.get(helper.id) ?? defaultBuddy(helper.thread.provider),
            status: helper.thread.status,
            step: helper.thread.status === "working" ? stepOf(helperActivities, helper.id) : undefined,
            role: "helper",
          };
        }
        const provider = helper.terminal.agent?.provider ?? "";
        const status = helper.terminal.status;
        return {
          id: helper.id,
          name: helper.terminal.name ?? providerName(provider),
          agent: providerName(provider),
          provider,
          buddy: buddies.get(helper.id) ?? defaultBuddy(provider),
          status: status === "running" ? "working" : status === "starting" ? "starting" : "stopped",
          step: undefined,
          role: "helper",
          terminal: true,
        };
      }),
    ];
  }, [thread, displayName, step, guests, helpers, buddies, guestActivities, helperActivities, projection.providers]);
  const personFor = (threadId: string): RoomPerson => {
    const known = people.find((person) => person.id === threadId);
    if (known) return known;
    const earlier = chain.find((entry) => entry.threadId === threadId) ?? thread;
    return {
      id: earlier.threadId,
      name: nameOfThread(earlier),
      agent: providerDisplayName(earlier.provider, projection.providers),
      provider: earlier.provider,
      buddy: buddyOf(earlier.threadId, earlier.provider),
      status: "stopped",
      step: undefined,
      role: "host",
    };
  };
  function speakerName(message: ThreadMessageProjection): string {
    return personFor(message.threadId).name;
  }
  // With more than one agent talking, each run of replies opens with who is speaking.
  const speakerAt = useMemo(() => {
    const starts = new Set<number>();
    if (guests.length === 0) return starts;
    let last: string | undefined;
    timeline.forEach((item, index) => {
      if (item.kind !== "message") return;
      const { role, threadId: writer } = item.message;
      if (role === "user") {
        last = undefined;
        return;
      }
      if (role !== "assistant" || isSwitchNotice(item.message)) return;
      if (writer !== last) starts.add(index);
      last = writer;
    });
    return starts;
  }, [timeline, guests.length]);

  const projectAgentNames = () => {
    const projectId = worktree?.projectId;
    const inProject = (worktreeId: string) =>
      projection.worktrees.find((entry) => entry.worktreeId === worktreeId)?.projectId === projectId;
    return [
      ...projection.threads
        .filter((entry) => inProject(entry.worktreeId) && isListedThreadStatus(entry.status))
        .map((entry) => entry.name),
      ...projection.terminals.filter((entry) => entry.agent && inProject(entry.worktreeId)).map((entry) => entry.name),
    ];
  };
  const [bringing, setBringing] = useState<string>();
  const [insertRequest, setInsertRequest] = useState<{
    text: string;
    nonce: number;
    replace?: boolean;
    mention?: MentionOption;
  }>();
  // Calling someone puts a removable chip for them at the start of the message box.
  const callOut = (person: { name: string; buddy: Buddy; provider: string; detail?: string }) =>
    setInsertRequest({
      text: "",
      nonce: Date.now(),
      mention: { name: person.name, buddy: person.buddy, provider: person.provider, detail: person.detail ?? "" },
    });
  const bringIn = async (
    request: GuestRequest,
    announce: boolean,
    buddy?: Buddy,
  ): Promise<{ threadId: string; name: string } | undefined> => {
    if (!onBringIn) return undefined;
    setError(undefined);
    const name = freeAgentName(request.name, projectAgentNames());
    setBringing(name);
    const result = await onBringIn({ ...request, name });
    setBringing(undefined);
    if ("error" in result) {
      setError(result.error);
      return undefined;
    }
    if (announce)
      callOut({
        name,
        buddy: buddy ?? defaultBuddy(request.provider),
        provider: request.provider,
        detail: `${providerDisplayName(request.provider, projection.providers)} · in this chat`,
      });
    return { threadId: result.threadId, name };
  };
  const nextBuddy = (provider: string): Buddy => freeBuddy(provider, buddies.values());
  const presentNames = new Set(
    people.filter((person) => person.role !== "host").map((person) => agentNameKey(person.name)),
  );
  // Bring in opens from the + menu of the message box, or the Bring in button by the chips, anchored to it.
  const [bringMenu, setBringMenu] = useState<MenuRequest>();
  const [bringMode, setBringMode] = useState<GuestMode>("ask");
  // Working on a copy needs Git and a branch to copy.
  const canWork = gitProject && worktree !== undefined && worktree.branch !== "HEAD";
  const takenBranches = () => projection.worktrees.map((entry) => entry.branch);
  const bringInItems =
    onBringIn && canSend && worktree
      ? (mode: GuestMode, reopen: (mode: GuestMode) => void): MenuItem[] => {
          const items: MenuItem[] = [];
          // The mode comes first: picking one shows the same agents again, set to join that way.
          items.push(
            {
              id: "mode-ask",
              label: "Ask, read only",
              icon: "message",
              checked: mode === "ask",
              title: guestModeHint.ask,
              run: () => reopen("ask"),
            },
            ...(canWork
              ? [
                  {
                    id: "mode-work",
                    label: "Work on a copy",
                    icon: "branch" as const,
                    checked: mode === "work",
                    title: guestModeHint.work,
                    run: () => reopen("work"),
                  },
                ]
              : []),
            { separator: true },
          );
          const joins = (name: string, agent: string) =>
            mode === "work"
              ? `Works on ${guestBranchName(worktree.branch, name, takenBranches())}, on ${agent}`
              : `Joins to answer, read only, on ${agent}`;
          const saved = teammates.filter((teammate) => !presentNames.has(agentNameKey(teammate.name)));
          if (saved.length > 0) {
            items.push({ heading: "Your buddies" });
            for (const teammate of saved) {
              items.push({
                id: `teammate-${teammate.id}`,
                label: teammate.name,
                media: <BuddyAvatar buddy={teammate.buddy} provider={teammate.provider} size={20} />,
                title: joins(
                  teammate.name,
                  `${providerDisplayName(teammate.provider, projection.providers)}${teammate.model ? `, ${teammate.model}` : ""}`,
                ),
                run: () =>
                  void bringIn(
                    {
                      provider: teammate.provider,
                      name: teammate.name,
                      mode,
                      ...(teammate.model ? { model: teammate.model } : {}),
                      ...(teammate.permissionMode ? { permissionMode: teammate.permissionMode } : {}),
                    },
                    true,
                    teammate.buddy,
                  ),
              });
            }
          }
          const agents = listedDiscoveries(projection.providers).filter(
            (entry) => entry.status === "found" && isSelectableProvider(entry.provider),
          );
          if (agents.length > 0) {
            items.push({ heading: saved.length > 0 ? "Or any agent" : "Any agent" });
            for (const entry of agents) {
              const buddy = nextBuddy(entry.provider);
              items.push({
                id: `agent-${entry.provider}`,
                label: entry.displayName,
                media: <BuddyAvatar buddy={buddy} provider={entry.provider} size={20} />,
                title: `${buddyName(buddy)}. ${joins(buddyName(buddy), entry.displayName)}`,
                run: () => void bringIn({ provider: entry.provider, name: buddyName(buddy), mode }, true, buddy),
              });
            }
          }
          return items;
        }
      : undefined;
  // Agents working on their own copy, each with the card that shows its changes.
  const guestCopies = guests.flatMap((guest) => {
    if (guestModeOf(guest, thread.worktreeId) !== "work") return [];
    const copy = projection.worktrees.find((entry) => entry.worktreeId === guest.worktreeId);
    return copy && copy.status !== "cancelled" ? [{ guest, worktree: copy }] : [];
  });
  // The chip's menu works through the card, so a merge or discard reads the same from either place.
  const [cardAsk, setCardAsk] = useState<{ threadId: string; action: GuestCardAction; nonce: number }>();
  const askCard = (threadId: string, action: GuestCardAction) => setCardAsk({ threadId, action, nonce: Date.now() });
  const openBringMenu = (anchor: HTMLElement | undefined, mode: GuestMode = bringMode) => {
    if (!bringInItems) return;
    const rect = anchor?.getBoundingClientRect();
    setBringMode(mode);
    setBringMenu({
      x: rect?.left ?? 0,
      y: (rect?.bottom ?? 0) + 4,
      align: "start",
      anchor,
      label: "Ask an agent",
      items: bringInItems(mode, (next) => openBringMenu(anchor, next)),
    });
  };
  const personItems = (person: RoomPerson): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!person.terminal) {
      items.push({
        id: "call",
        label: `Message ${person.name}`,
        icon: "message",
        run: () => callOut({ ...person, detail: `${person.agent} · in this chat` }),
      });
    }
    const copy = person.mode === "work" ? guestCopies.find((entry) => entry.guest.threadId === person.id) : undefined;
    if (copy) {
      items.push({
        id: "changes",
        label: `Show ${person.name}'s changes`,
        icon: "diff",
        run: () => askCard(copy.guest.threadId, "show"),
      });
      if (copy.guest.status !== "working") {
        items.push({
          id: "merge",
          label: "Merge into my branch",
          icon: "merge",
          run: () => askCard(copy.guest.threadId, "merge"),
        });
      }
      if (onDiscardGuest) {
        items.push({
          id: "discard",
          label: `Discard ${person.name}'s copy`,
          icon: "trash",
          tone: "danger",
          run: () => askCard(copy.guest.threadId, "discard"),
        });
      }
    }
    if (onOpenAgent) {
      items.push({
        id: "open",
        label: person.terminal ? `Open ${person.name}'s terminal` : `Open ${person.name}'s own chat`,
        icon: "externalLink",
        run: () => onOpenAgent(person.id),
      });
    }
    if (person.status !== "stopped" && person.status !== "failed") {
      items.push({
        id: "stop",
        label: `Stop ${person.name}`,
        icon: "square",
        tone: "danger",
        run: () =>
          void run(
            person.terminal
              ? { type: "terminal.stop", terminalId: person.id }
              : { type: "thread.stop", threadId: person.id },
          ),
      });
    }
    return items;
  };
  const mentions = useMemo((): MentionOption[] => {
    const inChat = people
      .filter((person) => person.role !== "host" && !person.terminal)
      .map((person) => ({
        name: person.name,
        buddy: person.buddy,
        provider: person.provider,
        detail: `${person.agent} · ${person.role === "helper" ? "helper" : "in this chat"}`,
      }));
    const present = new Set(inChat.map((option) => agentNameKey(option.name)));
    // An agent in another chat of the project gets the message in its own chat.
    const elsewhere: MentionOption[] = [];
    for (const peer of peers) {
      const name = peer.name ?? providerDisplayName(peer.provider, projection.providers);
      if (present.has(agentNameKey(name))) continue;
      present.add(agentNameKey(name));
      const branch = projection.worktrees.find((entry) => entry.worktreeId === peer.worktreeId)?.branch;
      elsewhere.push({
        name,
        buddy: defaultBuddy(peer.provider),
        provider: peer.provider,
        detail: `${providerDisplayName(peer.provider, projection.providers)} · another chat${branch ? `, ${branch}` : ""}`,
        kind: "peer",
      });
    }
    const taken = present;
    // A buddy called with @Name gets the message as a job, in its own worktree and chat.
    const team = (projection.buddies ?? [])
      .filter((buddy) => !buddy.archived && !taken.has(agentNameKey(buddy.name)))
      .map((buddy) => ({
        name: buddy.name,
        buddy: buddy.color,
        provider: buddy.engine.mode === "auto" ? "" : buddy.engine.provider,
        detail: `${buddy.title ? `${buddy.title} · ` : ""}gets this as a job`,
        kind: "buddy" as const,
      }));
    return [...inChat, ...elsewhere, ...team];
  }, [people, peers, projection.buddies, projection.worktrees, projection.providers]);

  /** A message for an agent in another chat of the project, which it reads in its own chat. */
  const sendToPeer = async (targetThreadId: string, text: string): Promise<boolean> => {
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "thread.a2a",
          messageId: makeCommandId(),
          sourceThreadId: thread.threadId,
          targetThreadId,
          text,
        },
      });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
      return false;
    }
  };

  const queueTo = async (
    targetId: string,
    text: string,
    attachments: ComposerAttachment[],
    context: string | undefined,
  ): Promise<boolean> => {
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "thread.queue",
          queueId: makeCommandId(),
          threadId: targetId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(context ? { context } : {}),
        },
      });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      stickToBottom.current = true;
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
      return false;
    }
  };

  /**
   * A message that opens with @Name goes to that member of the chat, or to that buddy as a job. Anything else
   * goes to the chat's own agent.
   */
  const send = async (text: string, attachments: ComposerAttachment[]): Promise<boolean> => {
    setError(undefined);
    // "/btw question" asks beside the chat instead of in it.
    const aside = /^\/btw\b\s*/iu.exec(text.trim());
    if (aside) {
      openAside(text.trim().slice(aside[0].length));
      return true;
    }
    // "/compact" compacts the way this agent can. Focus text after it goes along where the agent takes it.
    if (isCompactCommand(text) && attachments.length === 0) {
      const refused = compactUnavailable ?? (compacting ? undefined : compactBlocked);
      if (refused) {
        setError(refused);
        return false;
      }
      return compacting ? true : compactNow(compactFocus(text));
    }
    const callable = people.filter((person) => person.role !== "host" && !person.terminal);
    const team = (projection.buddies ?? []).filter(
      (buddy) => !buddy.archived && !callable.some((person) => agentNameKey(person.name) === agentNameKey(buddy.name)),
    );
    const asked = leadingMentions(
      text,
      team.map((buddy) => buddy.name),
    );
    if (asked.names.length > 0 && worktree) {
      const goal = asked.rest.trim();
      if (!goal) {
        setError(`Say what the job is after @${asked.names[0]}.`);
        return false;
      }
      // A job carries only its goal: rather than drop pasted images or files, the send waits and keeps them.
      if (attachments.length > 0) {
        setError(
          `A job for @${asked.names[0]} can't take attached files yet. Remove them, or describe what's in them.`,
        );
        return false;
      }
      for (const name of asked.names) {
        const buddy = team.find((candidate) => agentNameKey(candidate.name) === agentNameKey(name));
        if (!buddy) continue;
        const response = await dispatch({
          protocolVersion: 1,
          commandId: makeCommandId(),
          command: {
            type: "task.assign",
            task: {
              taskId: makeCommandId(),
              buddyId: buddy.buddyId,
              projectId: worktree.projectId,
              kind: "job",
              goal,
              origin: { kind: "chat", threadId },
            },
          },
        });
        if (response?.accepted === false) {
          setError(response.error.message);
          return false;
        }
      }
      return true;
    }
    // An agent in another chat of the project, called by name, when nobody here answers to it.
    const peerNamed = (name: string) =>
      callable.some((person) => agentNameKey(person.name) === agentNameKey(name))
        ? undefined
        : peers.find((peer) => agentNameKey(nameOfThread(peer)) === agentNameKey(name));
    const { names, rest } = leadingMentions(text, [
      ...callable.map((person) => person.name),
      ...peers.map((peer) => nameOfThread(peer)),
    ]);
    if (names.length === 0) {
      const edited = editing ? editedMessage(editing) : undefined;
      const older = edited && edited.index !== lastUserIndex ? edited : undefined;
      const lastSent = timeline[lastUserIndex];
      const note = older
        ? replaceNote(splitAttachedFiles(older.message.text).text)
        : editing
          ? "The person edited their previous message. This message replaces it: follow this version, and undo or drop what you did for the earlier one where it no longer applies."
          : undefined;
      const sent = await sendToHost(text, attachments, note ? { note } : {});
      if (sent) {
        if (older && lastSent?.kind === "message") {
          markReplaced({ from: older.message.messageId, after: lastSent.message.messageId });
        }
        setEditing(undefined);
      }
      return sent;
    }
    // A message to another chat carries only its text: rather than drop pasted images or files, the send waits and
    // keeps them, before anything goes out.
    const peerCalled = names.find((called) => peerNamed(called) !== undefined);
    if (peerCalled && attachments.length > 0) {
      setError(
        `A message for @${peerCalled} in another chat can't take attached files yet. Remove them, or send them here.`,
      );
      return false;
    }
    let sent = true;
    for (const called of names) {
      const target = callable.find((person) => agentNameKey(person.name) === agentNameKey(called));
      const peer = target ? undefined : peerNamed(called);
      if (peer) {
        sent = (await sendToPeer(peer.threadId, rest.trim() || text)) && sent;
        continue;
      }
      if (!target) continue;
      const targetId = target.id;
      const name = target.name;
      let joining = false;
      // A buddy brought into the chat reads its standing instructions and what it remembers.
      const instructions = teammateNamed(teammates, name)?.instructions;
      let mode: { kind: "ask" } | { kind: "work"; branch: string } | undefined;
      if (target.role === "guest") {
        joining = !roomMessages.some((message) => message.threadId === target.id && message.role === "user");
        const copy = guestCopies.find((entry) => entry.guest.threadId === target.id);
        mode = copy
          ? { kind: "work", branch: copy.worktree.branch }
          : target.mode === "ask"
            ? { kind: "ask" }
            : undefined;
      }
      const id = targetId;
      const context =
        target.role === "helper"
          ? undefined
          : roomBrief({
              name,
              joining,
              others: people.filter((person) => person.id !== id && !person.terminal).map((person) => person.name),
              branch: worktree?.branch ?? "the current branch",
              missed: missedBy(new Set([id]), roomMessages),
              nameOf: speakerName,
              instructions,
              mode,
            });
      sent = (await queueTo(id, text, attachments, context)) && sent;
    }
    return sent;
  };
  // Every open request in the chat, the host's first, for the one card that pages through them.
  const pendingRequests: PendingRequest[] = [
    ...hostRequests.map((entry) => ({ entry, provider: thread.provider, name: displayName })),
    ...guestRequests.flatMap((entry) => {
      const guest = guests.find((candidate) => candidate.threadId === entry.threadId);
      return guest ? [{ entry, provider: guest.provider, name: nameOfThread(guest) }] : [];
    }),
  ].map(({ entry, provider, name }) => ({
    request: entry,
    provider,
    displayName: name,
    onRespond: (decision: unknown) =>
      run({ type: "thread.respond", threadId: entry.threadId, requestId: entry.requestId, decision }),
    onAnswer: (answers: Record<string, string>) =>
      run({ type: "thread.user-input", threadId: entry.threadId, requestId: entry.requestId, answers }),
  }));
  const busyPeople = people.filter(
    (person) =>
      person.role !== "host" &&
      (person.status === "working" || person.status === "waiting" || person.status === "starting"),
  );

  /* ---------- Plan, follow-ups, review, side questions ---------- */

  // The agent's latest plan, from its todo list or plan updates, for the card above the message box.
  const plan = useMemo(
    () => activities.findLast((activity) => activity.todos && activity.todos.length > 0),
    [activities],
  );
  const planKey = plan ? `${plan.activityId}:${plan.todos?.filter((todo) => todo.status === "completed").length}` : "";
  const [hiddenPlan, setHiddenPlan] = useState<string>();
  const showPlan = plan?.todos && hiddenPlan !== planKey && (working || plan.turnId === lastTurnId(messages));

  // The last thing in the conversation, which decides what is offered after it.
  const lastIndex = timeline.length - 1;
  const lastItem = timeline[lastIndex];
  const lastReplyIndex = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item?.kind !== "message") continue;
      if (item.message.role === "user") return -1;
      if (item.message.role === "assistant" && !isSwitchNotice(item.message) && !guestIds.has(item.message.threadId))
        return index;
    }
    return -1;
  }, [timeline, guestIds]);
  const lastReply = lastReplyIndex >= 0 ? turns.replies.get(lastReplyIndex) : undefined;
  const lastAsk = useMemo(() => messages.findLast((message) => message.role === "user")?.text ?? "", [messages]);
  const settled = !working && queued.length === 0 && canSend;
  const followUps = useMemo(() => (settled && lastReply ? followUpsIn(lastReply) : []), [settled, lastReply]);
  const findings = useMemo(
    () => (settled && lastReply && /\breview/iu.test(lastAsk) ? reviewFindings(lastReply) : []),
    [settled, lastReply, lastAsk],
  );
  // A chat cut off mid-task, as when the app closed while the agent worked: its last word is the person's,
  // or a step never finished. A chat stopped at the usage limit has its own note above the message box.
  // Continue hides once clicked, until the chat moves on: the queued message reaches the projection a
  // moment after the click, and a second click before then would send it twice.
  const chatPoint = `${thread.status}:${timeline.length}`;
  const [continuedAt, setContinuedAt] = useState<string>();
  const cutOff =
    continuedAt !== chatPoint &&
    resumable &&
    !thread.usageLimit &&
    !working &&
    queued.length === 0 &&
    (thread.status === "failed" ||
      (lastItem?.kind === "message" && lastItem.message.role === "user") ||
      (lastItem?.kind === "work" && lastItem.activities.some((activity) => activity.status === "running")));
  // In read-only mode a finished reply is a plan; approving it lets the agent build it.
  const [approvedAt, setApprovedAt] = useState<number>();
  const planToApprove =
    threadMode === "read-only" &&
    settled &&
    lastReplyIndex >= 0 &&
    lastReplyIndex === lastIndex &&
    approvedAt !== lastIndex;

  // Editing a message puts it back in the box; the next send replaces it. An older one can only be replaced
  // by a new message, so the turns after it stay in the chat, dimmed.
  const [editing, setEditing] = useState<string>();
  const [replacedRanges, setReplacedRanges] = useState<ReplacedRange[]>(() => loadReplaced(thread.threadId));
  const markReplaced = (range: ReplacedRange) =>
    setReplacedRanges((ranges) => {
      const next = [...ranges, range];
      saveReplaced(thread.threadId, next);
      return next;
    });
  const replaced = useMemo(() => replacedIndexes(timeline, replacedRanges), [timeline, replacedRanges]);
  const editedMessage = (messageId: string) => {
    const index = timeline.findIndex((item) => item.kind === "message" && item.message.messageId === messageId);
    const item = timeline[index];
    return item?.kind === "message" ? { index, message: item.message } : undefined;
  };
  const lastUserIndex = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item?.kind === "message" && item.message.role === "user") return index;
    }
    return -1;
  }, [timeline]);
  const editingOlder = editing !== undefined && (editedMessage(editing)?.index ?? lastUserIndex) !== lastUserIndex;
  // Regenerate sends the person's last message again, as they wrote it, for a fresh answer.
  const lastSent = lastUserIndex >= 0 ? timeline[lastUserIndex] : undefined;
  const regenerable =
    lastSent?.kind === "message" &&
    lastSent.message.threadId === thread.threadId &&
    lastSent.message.text.trim() !== "" &&
    continuedAt !== chatPoint
      ? lastSent.message
      : undefined;
  const regenerate = () => {
    if (!regenerable) return;
    setContinuedAt(chatPoint);
    void sendToHost(regenerable.text, regenerable.attachments ?? [], {
      note: "The person asked for a new answer to this message. Answer it again from the start.",
    }).then((sent) => {
      if (!sent) setContinuedAt(undefined);
    });
  };
  const editMessage = useCallback((message: ThreadMessageProjection) => {
    setEditing(message.messageId);
    // Only the typed words go back in the box, as with attached files; the agent has the old blocks already.
    const typed = splitAttachedContext(splitAttachedFiles(message.text).text).body;
    setInsertRequest({ text: typed, nonce: Date.now(), replace: true });
  }, []);

  // Branching: a new chat that carries the conversation up to a reply.
  // biome-ignore lint/correctness/useExhaustiveDependencies: personFor reads the people of this render.
  const branchAt = useCallback(
    (index: number) => {
      if (!onBranch) return;
      const upTo: ThreadMessageProjection[] = [];
      for (const item of timeline.slice(0, index + 1)) {
        if (
          item.kind === "message" &&
          (item.message.role === "user" || item.message.role === "assistant") &&
          !isSwitchNotice(item.message)
        )
          upTo.push(item.message);
      }
      const context = takeoverContext({
        branch: worktree?.branch ?? "the current branch",
        messages: upTo,
        nameOf: (message) => personFor(message.threadId).name,
      });
      if (context) onBranch({ from: displayTitle(messages), context });
    },
    [onBranch, timeline, worktree?.branch, messages],
  );

  // A side question: asked beside the chat, answered by a short read-only chat that never writes back.
  const [aside, setAside] = useState<{ threadId?: string; starting: boolean; error?: string | undefined }>();
  const asideRef = useRef(aside);
  asideRef.current = aside;
  const closeAside = useCallback(() => {
    const threadIdOfAside = asideRef.current?.threadId;
    if (threadIdOfAside) onCloseAside?.(threadIdOfAside);
    asideSeenRef.current = undefined;
    setAside(undefined);
  }, [onCloseAside]);
  // The last main chat message the side agent has read, so a follow-up carries only what was said since.
  const asideSeenRef = useRef<string | undefined>(undefined);
  const askAside = async (question: string) => {
    const current = asideRef.current;
    const said = roomMessages.filter((message) => message.role === "user" || message.role === "assistant");
    const seen = asideSeenRef.current;
    asideSeenRef.current = said.at(-1)?.messageId ?? seen;
    if (current?.threadId) {
      setAside({ ...current, error: undefined });
      const update = sideQuestionUpdate(said, seen, speakerName);
      const ok = await queueTo(current.threadId, question, [], update);
      if (!ok) setAside((value) => (value ? { ...value, error: "The question could not be sent." } : value));
      return;
    }
    if (!onAskAside) return;
    setAside({ starting: true });
    const started = await onAskAside(question, sideQuestionContext(said, speakerName));
    setAside(
      "error" in started ? { starting: false, error: started.error } : { starting: false, threadId: started.threadId },
    );
  };
  const openAside = (question: string) => {
    if (!onAskAside) return;
    if (!asideRef.current) setAside({ starting: false });
    if (question.trim()) void askAside(question.trim());
  };
  // Compacting: the agent's own /compact where its CLI has one, else a summary and a fresh session of the
  // same agent. It always goes through the queue, so it runs between turns and never cuts one short.
  const compactWay = compactionMode(thread);
  const { autoCompact } = useAppSettings();
  const conversationStarted = messages.some((message) => message.role === "user" && !isCompactionRequest(message));
  const compactUnavailable = ended
    ? "This chat has ended."
    : compactWay === "summary" && !onSwitchAgent
      ? "This chat cannot move to a fresh session."
      : !conversationStarted
        ? "Nothing to compact yet."
        : undefined;
  const compacting =
    queued.some((entry) =>
      isCompactionRequest({ messageId: entry.queueId, threadId, role: "user", text: entry.text }),
    ) || [...compactions.values()].some((view) => view.state === "compacting");
  // For now only: a turn is running, a request waits on the person, or the chat has just compacted.
  const compactBlocked =
    threadStatus === "working" || threadStatus === "starting"
      ? "Wait for the current turn to finish before compacting."
      : threadStatus === "waiting" || waitingCount > 0
        ? "Answer the open request before compacting."
        : endsWithCompaction(messages)
          ? "This chat was just compacted. Send a message before compacting again."
          : undefined;
  const compactNow = async (focus?: string): Promise<boolean> => {
    if (compactUnavailable || compacting) return false;
    if (compactBlocked) {
      setError(compactBlocked);
      return false;
    }
    setError(undefined);
    return queueTo(thread.threadId, compactRequestText(thread, focus), [], undefined);
  };
  const compactRefusal = compactUnavailable ?? compactBlocked;
  const compactAction: CompactAction = {
    status: compacting ? "compacting" : compactRefusal ? "unavailable" : "ready",
    run: () => void compactNow(),
    ...(compactRefusal && !compacting
      ? { note: compactRefusal }
      : compactWay === "summary"
        ? { note: `${displayName} has no compact command, so it writes a summary and carries on in a fresh session.` }
        : {}),
    ...(autoCompact.enabled ? { autoAt: autoCompact.at } : {}),
  };
  // The right panel's overview offers the same action for the chat in view. It is published by value, with a
  // run that always reaches this render's compactNow.
  const compactRun = useRef(compactAction.run);
  compactRun.current = compactAction.run;
  const offersCompact = !(ended && !resumable);
  const { status: compactStatus, note: compactNote, autoAt: compactAutoAt } = compactAction;
  useEffect(() => {
    publishCompactAction(
      threadId,
      offersCompact
        ? {
            status: compactStatus,
            run: () => compactRun.current(),
            ...(compactNote !== undefined ? { note: compactNote } : {}),
            ...(compactAutoAt !== undefined ? { autoAt: compactAutoAt } : {}),
          }
        : undefined,
    );
  }, [threadId, offersCompact, compactStatus, compactNote, compactAutoAt]);
  useEffect(() => () => publishCompactAction(threadId, undefined), [threadId]);
  // Once the summary is in, the chat carries on in a fresh session of the same agent and model. The
  // summary goes to it with the person's next message.
  const handedOff = useRef<string>(undefined);
  const pendingSummary =
    compactWay === "summary" && threadStatus === "idle" && queued.length === 0 ? latestSummary(messages) : undefined;
  const summaryRequestId =
    pendingSummary && pendingSummary.after.length === 0 ? messages.findLast(isCompactionRequest)?.messageId : undefined;
  useEffect(() => {
    if (!summaryRequestId || !onSwitchAgent || handedOff.current === summaryRequestId) return;
    handedOff.current = summaryRequestId;
    void onSwitchAgent(thread.provider, model ?? thread.model).then((failure) => {
      if (!failure) return;
      setHandoffFailed(summaryRequestId);
      setError(`The chat could not move to a fresh session. ${failure}`);
    });
  }, [summaryRequestId, onSwitchAgent, thread.provider, thread.model, model]);
  // After a turn that leaves the context nearly full, the chat compacts by itself, once per turn.
  const autoFor = useRef<string>(undefined);
  const latestUsageId = usage.at(-1)?.usageId;
  const autoDue = shouldAutoCompact({
    enabled: autoCompact.enabled && !compactUnavailable,
    threshold: autoCompact.at,
    context,
    idle: threadStatus === "idle",
    busy: compacting || queued.length > 0 || waitingCount > 0,
    justCompacted: endsWithCompaction(messages),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: compactNow reads the same state autoDue comes from.
  useEffect(() => {
    if (!autoDue || !latestUsageId || autoFor.current === latestUsageId) return;
    autoFor.current = latestUsageId;
    // Automatic compacting asks the agent to keep the work in hand, where its command takes a focus.
    void compactNow(thread.capabilities.compactionInstructions ? DEFAULT_COMPACT_FOCUS : undefined);
  }, [autoDue, latestUsageId]);
  // "/" in the message box: what this chat can do, and what the agent's own CLI takes as a message.
  const composerCommands: ComposerCommand[] = [
    { name: "new", description: "Start a new chat", run: onRestart },
    ...(onAskAside ? [{ name: "btw", description: "Ask a side question while the agent works", insert: "/btw" }] : []),
    // Native compaction is the agent's own command; the summary way is ZLI's. Both wait for the turn to end.
    ...(!compactUnavailable
      ? [
          {
            name: "compact",
            description:
              compactWay === "native"
                ? "Compact the conversation to free up context"
                : "Summarize the conversation and carry on in a fresh session",
            run: () => void compactNow(),
            source: compactWay === "native" ? ("agent" as const) : ("zli" as const),
          },
        ]
      : []),
  ];
  // The side question shortcut (Ctrl+; by default, set in Settings) opens a side question in the chat in focus.
  const sideQuestionShortcut = useShortcut("sideQuestion");
  useEffect(() => {
    if (!active || !onAskAside) return;
    return onSideQuestionRequest(() => setAside((current) => current ?? { starting: false }));
  }, [active, onAskAside]);

  const renderItem = (index: number, withChanges: boolean) => {
    const item = timeline[index];
    if (!item) return null;
    const body = renderItemBody(item, index);
    const key = item.kind === "work" ? `work-${item.key}` : (item.key ?? item.message.messageId);
    return (
      <Fragment key={key}>
        {replaced.has(index) ? (
          <div className="chat-replaced">
            {replaced.has(index - 1) ? null : <p className="chat-replaced-label">Replaced by your edit</p>}
            {body}
          </div>
        ) : (
          body
        )}
        {withChanges ? placedCheckpoints.after.get(index)?.map(turnChanges) : null}
      </Fragment>
    );
  };
  const renderItemBody = (item: (typeof timeline)[number], index: number) => {
    return (
      <>
        {item.kind === "work" ? (
          <ChatWork
            item={item}
            showChangedFiles={!placedCheckpoints.turns.has(item.turnId)}
            onOpenDiff={openDiff}
            links={fileLinks}
          />
        ) : isCompactionNotice(item.message) ? (
          (() => {
            const view = compactions.get(compactionRequestId(item.message));
            return view ? (
              <CompactionDivider compaction={view.compaction} state={view.state} saved={view.saved} />
            ) : null;
          })()
        ) : isSwitchNotice(item.message) ? (
          <div className="chat-switch" role="note">
            <span className="chat-switch-line" aria-hidden="true" />
            <span className="chat-switch-text">{item.message.text}</span>
            <span className="chat-switch-line" aria-hidden="true" />
          </div>
        ) : (
          <>
            {speakerAt.has(index) ? <RoomSpeaker person={personFor(item.message.threadId)} /> : null}
            <ChatMessage
              message={item.message}
              index={index}
              links={fileLinks}
              source={item.message.role === "agent" ? sourceLabel(projection, item.message.sourceThreadId) : ""}
              // A reply still being written has no Copy yet: it would copy half an answer.
              reply={working && index >= turns.latestStart ? undefined : turns.replies.get(index)}
              sources={item.message.turnId ? sourcesByTurn.get(item.message.turnId) : undefined}
              workedFor={
                item.message.turnId && !foldedTurns.has(item.message.turnId)
                  ? worked.get(item.message.turnId)
                  : undefined
              }
              onEdit={
                settled && item.message.threadId === thread.threadId && !replaced.has(index) ? editMessage : undefined
              }
              onBranch={onBranch && !working ? branchAt : undefined}
              onRegenerate={
                index === lastReplyIndex && settled && !cutOff && regenerable && !replaced.has(index)
                  ? regenerate
                  : undefined
              }
            />
            {/* The next steps a reply suggests sit right under it, where they were read. */}
            {index === lastReplyIndex && followUps.length > 0 && findings.length === 0 ? (
              <FollowUps items={followUps} onHere={(task) => void send(task, [])} onNewChat={onNewChatWithPrompt} />
            ) : null}
          </>
        )}
      </>
    );
  };

  // What waits on the person sits on the message box, above the workspace tab: the plan, with its go-ahead
  // when the agent only planned, and a side question.
  const sideChat = aside ? (
    <SideChat
      threadId={aside?.threadId}
      starting={aside?.starting ?? false}
      error={aside?.error}
      onAsk={(question) => void askAside(question)}
      onClose={closeAside}
      // The answer goes to the top of the message box, to read over and send from there.
      onSendToChat={
        ended && !resumable ? undefined : (text) => setInsertRequest({ text: `${text}\n\n`, nonce: Date.now() })
      }
    />
  ) : null;
  const trayAside = sideChat;
  const planTodos = showPlan ? plan?.todos : undefined;
  const planApproval: PlanApprovalAction | undefined =
    planToApprove && !request
      ? {
          canSwitch: permissionSwitch,
          onApprove: () => {
            setApprovedAt(lastIndex);
            if (permissionSwitch) setPermissionMode("full-access");
            void sendToHost("Go ahead with the plan.", [], permissionSwitch ? { permissionMode: "full-access" } : {});
          },
          onChange: () => {
            setApprovedAt(lastIndex);
            setInsertRequest({ text: "Change the plan: ", nonce: Date.now(), replace: true });
          },
        }
      : undefined;
  const traySections =
    planTodos || trayAside || planApproval ? (
      <>
        {planTodos || planApproval ? (
          <PlanCard
            todos={planTodos ?? []}
            working={working}
            approval={planApproval}
            onDismiss={() => setHiddenPlan(planKey)}
          />
        ) : null}
        {trayAside}
      </>
    ) : null;

  return (
    <div className="chat-view" ref={viewRef}>
      <ChatImageScope value={worktree?.worktreeId}>
        <div className="chat-stage">
          <div
            className="chat-log"
            role="log"
            aria-label="Agent conversation"
            ref={logRef}
            onScroll={(event) => {
              const target = event.currentTarget;
              const atEnd = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
              stickToBottom.current = atEnd;
              setAway(!atEnd);
              if (atEnd) setUnseen(false);
            }}
          >
            <div className="chat-column">
              {hiddenRows > 0 ? <EarlierRows rootRef={logRef} onShow={showEarlier} /> : null}
              {timeline.length === 0 && earlyMessages.length === 0 ? (
                <ChatStart provider={thread.provider} folder={project?.name} />
              ) : (
                visibleRows.map((row) =>
                  row.kind === "item" ? (
                    renderItem(row.index, true)
                  ) : (
                    <Fragment key={row.key}>
                      <TurnFold
                        summary={trailSummary(row.activities)}
                        time={worked.get(row.activities[0]?.turnId ?? "")}
                        open={openFolds.has(row.key)}
                        onToggle={() => toggleFold(row.key)}
                      >
                        {row.indexes.map((index) => renderItem(index, false))}
                      </TurnFold>
                      {row.indexes.flatMap((index) => placedCheckpoints.after.get(index)?.map(turnChanges) ?? [])}
                    </Fragment>
                  ),
                )
              )}
              {placedCheckpoints.unplaced.map(turnChanges)}
              {findings.length > 0 ? (
                <ReviewCard
                  key={`review-${lastReplyIndex}`}
                  findings={findings}
                  onFixAll={() => void send("Fix all the findings from your review.", [])}
                  onFixOne={(finding) =>
                    void send(
                      `Fix this finding from your review: ${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.text}`,
                      [],
                    )
                  }
                  onOpenFile={fileLinks ? openFile : undefined}
                />
              ) : null}
              {worktree
                ? guestCopies.map((copy) => (
                    <GuestWorkCard
                      key={copy.guest.threadId}
                      name={nameOfThread(copy.guest)}
                      hostBranch={worktree.branch}
                      worktree={copy.worktree}
                      review={projection.reviews?.find((entry) => entry.worktreeId === copy.worktree.worktreeId)}
                      working={copy.guest.status === "working" || copy.guest.status === "starting"}
                      onOpenChanges={() => onOpenDiff()}
                      onDiscard={onDiscardGuest ? () => onDiscardGuest(copy.guest.threadId) : undefined}
                      ask={cardAsk?.threadId === copy.guest.threadId ? cardAsk : undefined}
                    />
                  ))
                : null}
              {cutOff ? (
                <ContinueRow
                  onContinue={() => {
                    setContinuedAt(chatPoint);
                    void sendToHost("Continue where you left off.", []).then((sent) => {
                      if (!sent) setContinuedAt(undefined);
                    });
                  }}
                  onRegenerate={regenerable ? regenerate : undefined}
                />
              ) : null}
              {earlyMessages.map((message, index) => (
                <ChatMessage
                  key={message.messageId}
                  message={message}
                  index={timeline.length + index}
                  links={fileLinks}
                  source=""
                />
              ))}
              {earlyMessages.length > 0 ? (
                <WorkingStatus label="Working" live />
              ) : working ? (
                <WorkingStatus
                  label={liveLabel}
                  live={!toolRunning && thread.status !== "waiting"}
                  since={turnStartedAt}
                />
              ) : null}
              {busyPeople.map((person) => (
                <RoomLive
                  key={person.id}
                  person={person}
                  onOpen={person.role === "helper" && onOpenAgent ? () => onOpenAgent(person.id) : undefined}
                />
              ))}
            </div>
          </div>
          <TurnRail prompts={turns.prompts} logRef={logRef} />
          {away ? (
            <button type="button" className={`chat-jump${unseen ? " is-new" : ""}`} onClick={jumpToLatest}>
              <Icon name="chevronDown" size={13} />
              {unseen ? "New messages" : "Latest"}
            </button>
          ) : null}
        </div>
      </ChatImageScope>
      <div className="chat-dock" ref={dockRef}>
        <div className="chat-column">
          {/* One thing above the message box at a time, the most pressing first: what holds the agent up, then
              the messages waiting their turn, then one quiet line about the chat. The next shows as each clears. */}
          <DockSlot
            item={firstDockItem([
              pendingRequests.length > 0 && {
                key: "requests",
                node: <RequestPager requests={pendingRequests} />,
              },
              connectorActivity?.connector && {
                key: `connector-${connectorActivity.activityId}`,
                node: (
                  <ConnectorCard
                    key={connectorActivity.activityId}
                    connector={connectorActivity.connector}
                    displayName={displayName}
                    onTryAgain={canSend ? (text) => send(text, []) : undefined}
                    onNewChat={() => void newChatForConnector()}
                    onOpenConnectors={onOpenConnectors}
                    onDismiss={() =>
                      setDismissedConnectors((current) => new Set(current).add(connectorActivity.activityId))
                    }
                  />
                ),
              },
              // A plan waiting for the go-ahead sits in the message box's tray, so nothing lesser shows over it.
              !(planToApprove && !request) &&
                queued.length > 0 &&
                earlyMessages.length === 0 && {
                  key: "queue",
                  node: (
                    <QueuedMessages
                      queued={queued}
                      displayName={displayName}
                      canSteer={!ended && thread.status !== "starting"}
                      pendingNote={
                        thread.status === "starting"
                          ? `Sent when ${displayName} is ready`
                          : ended
                            ? "Not sent"
                            : `Sent in order after ${displayName}'s current turn`
                      }
                      waiting={thread.status === "waiting" || waitingCount > 0}
                      onSteer={(queueId) => run({ type: "thread.steer", threadId: thread.threadId, queueId })}
                      onRemove={(queueId) => run({ type: "thread.queue.remove", threadId: thread.threadId, queueId })}
                    />
                  ),
                },
              !(planToApprove && !request) &&
                visibleError && {
                  key: "error",
                  node: (
                    <div className="chat-note is-error" role="alert">
                      <span className="chat-note-dot" aria-hidden="true" />
                      <span className="chat-note-text">{visibleError}</span>
                    </div>
                  ),
                },
              // The plan's limit stopped the agent: say when it resets, and offer to carry on then.
              !(planToApprove && !request) &&
                resumable &&
                thread.usageLimit && {
                  key: "usage-limit",
                  node: (
                    <UsageLimitNote
                      limit={thread.usageLimit}
                      onAutoResume={(autoResume) =>
                        void run({ type: "thread.limit.resume", threadId: thread.threadId, autoResume })
                      }
                      onContinue={() => void send("Continue where you left off.", [])}
                    />
                  ),
                },
              // A stopped chat needs no note: the next message picks up where it left off. A failure says why.
              !(planToApprove && !request) &&
                resumable &&
                thread.status === "failed" &&
                !thread.usageLimit &&
                thread.errorMessage && {
                  key: "failed",
                  node: (
                    <div className="chat-note is-error" role="status">
                      <span className="chat-note-dot" aria-hidden="true" />
                      <span className="chat-note-text">
                        <ErrorText text={thread.errorMessage} links={fileLinks} />
                      </span>
                    </div>
                  ),
                },
              !(planToApprove && !request) &&
                editing && {
                  key: "editing",
                  node: (
                    <div className="chat-note is-editing" role="status">
                      <Icon name="pencil" size={11} />
                      <span className="chat-note-text">
                        {editingOlder
                          ? "Editing an earlier message. Sending replaces it and what came after."
                          : "Editing your last message"}
                      </span>
                      <button type="button" onClick={() => setEditing(undefined)}>
                        Cancel
                      </button>
                    </div>
                  ),
                },
            ])}
          />
          {ended && !resumable && traySections ? <div className="composer-tray is-loose">{traySections}</div> : null}
          {ended && !resumable ? (
            <div className={`chat-ended${thread.status === "failed" ? " is-failed" : ""}`} role="status">
              <Icon name={thread.status === "failed" ? "alert" : "square"} size={13} />
              <span className="chat-ended-copy">
                <span className="chat-ended-title">
                  {thread.status === "failed" ? `${displayName} failed` : `${displayName} session ended`}
                </span>
                <span className="chat-ended-detail">
                  {thread.errorMessage ? (
                    <ErrorText text={thread.errorMessage} links={fileLinks} />
                  ) : (
                    "A new chat starts fresh in the same worktree."
                  )}
                </span>
              </span>
              {/* A branch carries the whole conversation into a new chat, where any agent can pick it up. */}
              {onBranch && lastIndex >= 0 ? (
                <Button
                  size="sm"
                  icon="branch"
                  tooltip="New chat with this conversation, on any agent"
                  onClick={() => branchAt(lastIndex)}
                >
                  Branch
                </Button>
              ) : null}
              <Button variant="primary" size="sm" icon="plus" onClick={onRestart}>
                New chat
              </Button>
            </div>
          ) : null}
          {ended && !resumable ? (
            <div className="composer-below chat-ended-below">
              <PullRequestStrip
                worktreeId={worktree?.worktreeId}
                displayName={displayName}
                onAsk={canSend ? (text) => void send(text, []) : undefined}
              />
            </div>
          ) : (
            <CompactActionContext.Provider value={compactAction}>
              {bringMenu ? <Menu request={bringMenu} onClose={() => setBringMenu(undefined)} /> : null}
              <Composer
                peopleItems={[
                  ...(bringInItems
                    ? [
                        {
                          id: "bring-in",
                          label: "Ask an agent",
                          icon: "users" as const,
                          title: "Bring an agent into this chat to answer, or to work on a copy",
                          run: () =>
                            openBringMenu(
                              document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
                            ),
                        },
                      ]
                    : []),
                  ...(onAskAside && !aside
                    ? [
                        {
                          id: "side-question",
                          label: "Ask a side question",
                          icon: "message" as const,
                          title: "Side question, not added to the chat",
                          shortcut: sideQuestionShortcut || undefined,
                          run: () => setAside((current) => current ?? { starting: false }),
                        },
                      ]
                    : []),
                ]}
                mentions={mentions}
                insertRequest={insertRequest}
                capture={bridge?.capture}
                displayName={displayName}
                provider={thread.provider}
                branch={worktree?.branch ?? "this worktree"}
                // While a card above the box holds the agent up, the plan waits in its place; a side question stays.
                tray={pendingRequests.length > 0 || connectorActivity?.connector ? trayAside : traySections}
                chips={
                  <>
                    <RoomBar
                      people={people}
                      onBringIn={bringInItems ? (anchor) => openBringMenu(anchor) : undefined}
                      bringing={bringing}
                      personItems={personItems}
                    />
                    <PullRequestStrip
                      worktreeId={worktree?.worktreeId}
                      displayName={displayName}
                      onAsk={canSend ? (text) => void send(text, []) : undefined}
                    />
                  </>
                }
                workspace={
                  worktree ? (
                    <WorkspaceBar
                      project={project}
                      projects={projection.projects}
                      worktree={worktree}
                      worktrees={projection.worktrees}
                      git={gitProject}
                      onMove={fresh ? onMoveChat : undefined}
                      onAddFolder={fresh ? onAddFolder : undefined}
                    />
                  ) : undefined
                }
                disabled={false}
                blocked={unavailable}
                queues={busy}
                models={models}
                model={model}
                modelLocked={modelLocked && !switchable}
                onModelChange={modelLocked && switchable ? (next) => switchAgent(thread.provider, next) : setModel}
                carriesOver={switchable && !fresh}
                agentName={agentName}
                agentPlan={discovery?.status === "found" ? accountPlan(discovery.login) : undefined}
                otherAgents={others}
                onAgentChange={switchable ? (next, nextModel) => switchAgent(next, nextModel) : undefined}
                reasoningLevels={reasoning.levels}
                defaultReasoning={startingReasoning ?? reasoning.defaultLevel}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={setChosenReasoning}
                fast={fastValue ? fastOn : undefined}
                onFastChange={setFastOn}
                permissionMode={permissionMode}
                onPermissionModeChange={permissionSwitch ? setPermissionMode : undefined}
                projectId={worktree?.projectId}
                worktreeId={worktree?.worktreeId}
                commands={composerCommands}
                references={references}
                onRemoveReference={(id) => removeCodeReference(thread.threadId, id)}
                onReferencesSent={() => clearCodeReferences(thread.threadId)}
                onSubmit={send}
                onStop={working ? stopTurn : undefined}
                bestOf={bestOf}
                active={active}
                draftKey={thread.sessionId ?? thread.threadId}
              />
            </CompactActionContext.Provider>
          )}
        </div>
      </div>
    </div>
  );
}

function QueuedMessages({
  queued,
  displayName,
  canSteer,
  pendingNote,
  waiting,
  onSteer,
  onRemove,
}: {
  queued: readonly ThreadQueuedMessage[];
  displayName: string;
  canSteer: boolean;
  pendingNote: string;
  waiting: boolean;
  onSteer(queueId: string): void;
  onRemove(queueId: string): void;
}) {
  return (
    <section className="chat-queue" aria-label="Queued messages">
      <p className="chat-queue-head">
        {queued.length === 1 ? "1 queued message" : `${queued.length} queued messages`}
        <span>{pendingNote}</span>
      </p>
      <ol className="chat-queue-list">
        {queued.map((message, index) => {
          const typed = splitAttachedFiles(message.text);
          const preview = splitAttachedContext(typed.text).body.trim().split(/\r?\n/u)[0] ?? "";
          const uploads = message.attachments ?? [];
          const files = [...uploads.map((file) => file.name), ...typed.paths.map(fileName)];
          const onlyImages = typed.paths.length === 0 && uploads.every((file) => file.mimeType !== "text/plain");
          return (
            <li className="chat-queue-item" key={message.queueId}>
              <span className="chat-queue-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="chat-queue-text" title={message.text}>
                {preview}
              </span>
              {files.length > 0 ? (
                <span className="chat-queue-meta" title={files.join(", ")}>
                  <Icon name={onlyImages ? "image" : "paperclip"} size={11} />
                  {files.length}
                  <span className="sr-only">{files.length === 1 ? " attachment" : " attachments"}</span>
                </span>
              ) : null}
              {canSteer ? (
                <Button
                  variant="ghost"
                  size="xs"
                  icon="arrowUp"
                  disabled={waiting}
                  tooltip={
                    waiting
                      ? `Answer ${displayName}'s request first`
                      : `Stop the current turn and send this to ${displayName} now`
                  }
                  aria-label={`Send now: ${preview}`}
                  onClick={() => onSteer(message.queueId)}
                >
                  Send now
                </Button>
              ) : null}
              <IconButton
                label={`Remove from queue: ${preview}`}
                tooltip="Remove from queue"
                icon="x"
                size="xs"
                iconSize={11}
                onClick={() => onRemove(message.queueId)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The step the agent is on in its current turn: the latest call still running after the last message sent. */
export function currentStep(timeline: readonly TimelineItem[]): ThreadActivityProjection | undefined {
  let start = 0;
  timeline.forEach((item, index) => {
    if (item.kind === "message" && item.message.role === "user") start = index + 1;
  });
  let running: ThreadActivityProjection | undefined;
  for (const item of timeline.slice(start)) {
    if (item.kind !== "work") continue;
    for (const activity of item.activities) if (activity.status === "running") running = activity;
  }
  return running;
}

const ChatWork = memo(function ChatWork({
  item,
  showChangedFiles,
  onOpenDiff,
  links,
}: {
  item: Extract<TimelineItem, { kind: "work" }>;
  /** Off once the turn has a checkpoint, which lists the same files with their real diff. */
  showChangedFiles: boolean;
  onOpenDiff(path?: string): void;
  links: FileLinks | undefined;
}) {
  // The plan has its own card above the message box, so its updates are not steps.
  const steps = useMemo(() => item.activities.filter((activity) => !activity.todos), [item.activities]);
  if (steps.length === 0 && !(showChangedFiles && item.changedFiles.length > 0)) return null;
  return (
    <div className="chat-work">
      {steps.length > 0 ? <WorkSteps activities={steps} onOpenFile={onOpenDiff} links={links} /> : null}
      {showChangedFiles && item.changedFiles.length > 0 ? (
        <ChangedFiles files={item.changedFiles} onOpenDiff={onOpenDiff} />
      ) : null}
    </div>
  );
});

/**
 * Each turn's changes go after the last timeline item of that turn. A turn with no reply and no
 * tool calls in the timeline, for example one stopped early, has nowhere to go and is listed last.
 */
export function placeCheckpoints(
  timeline: readonly TimelineItem[],
  checkpoints: readonly ThreadCheckpoint[],
): { after: Map<number, ThreadCheckpoint[]>; unplaced: ThreadCheckpoint[]; turns: Set<string> } {
  const lastIndex = new Map<string, number>();
  timeline.forEach((item, index) => {
    const turnId = item.kind === "work" ? item.turnId : item.message.turnId;
    if (turnId) lastIndex.set(turnId, index);
  });
  const after = new Map<number, ThreadCheckpoint[]>();
  const unplaced: ThreadCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    const index = lastIndex.get(checkpoint.turnId);
    if (index === undefined) {
      unplaced.push(checkpoint);
      continue;
    }
    after.set(index, [...(after.get(index) ?? []), checkpoint]);
  }
  return { after, unplaced, turns: new Set(checkpoints.map((checkpoint) => checkpoint.turnId)) };
}

/**
 * An agent the person brings into a chat: which agent, its name there, how it joins (to ask, read-only, or to
 * work on its own copy; Ask when left out), and optionally its model and access.
 */
export type GuestRequest = {
  provider: string;
  name: string;
  mode?: GuestMode;
  model?: string;
  permissionMode?: PermissionMode;
};

export type StartRunsRequest = {
  prompt: string;
  runs: RunAgent[];
  from: RunStart;
  permissionMode: PermissionMode;
};

/** A folded turn opens to its steps and remarks; closed, one line says what the agent did. */
function TurnFold({
  summary,
  time,
  open,
  onToggle,
  children,
}: {
  summary: string;
  /** "Worked for 1m 05s", when the turn's times are known. */
  time?: string | undefined;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <section className={`turn-fold${open ? " is-open" : ""}`} aria-label="Steps of an earlier turn">
      <button type="button" className="turn-fold-row" aria-expanded={open} onClick={onToggle}>
        <Icon name="chevronRight" size={11} className="turn-fold-chevron" />
        <span className="turn-fold-summary">{summary}</span>
        {time ? <span className="turn-fold-time">{time}</span> : null}
      </button>
      <Collapse open={open}>
        <div className="turn-fold-body">{children}</div>
      </Collapse>
    </section>
  );
}

const ChatMessage = memo(function ChatMessage({
  message,
  index,
  links,
  source,
  reply,
  sources,
  workedFor,
  onEdit,
  onBranch,
  onRegenerate,
}: {
  message: ThreadMessageProjection;
  /** Position in the timeline, which places the message among the saved turns. */
  index: number;
  links: FileLinks | undefined;
  source: string;
  /** The turn's whole reply, on its last part only, which offers to copy it. */
  reply?: string | undefined;
  /** Pages the turn's web steps read; links to them read as citations, and the last part lists them. */
  sources?: readonly Source[] | undefined;
  /** How long the turn worked, on its last part. */
  workedFor?: string | undefined;
  /** Puts the person's last message back in the box to change and send again. */
  onEdit?: ((message: ThreadMessageProjection) => void) | undefined;
  /** Starts a new chat with the conversation up to this reply. */
  onBranch?: ((index: number) => void) | undefined;
  /** Sends the person's last message again, on the last reply. */
  onRegenerate?: (() => void) | undefined;
}) {
  if (message.role === "user") {
    return <UserMessage message={message} links={links} onEdit={onEdit} />;
  }
  if (message.role === "agent") {
    return (
      <article className="chat-message chat-message-peer" data-trust="untrusted">
        <span className="chat-message-label">
          <Icon name="message" size={12} />
          {source}
        </span>
        <p>{message.text}</p>
      </article>
    );
  }
  if (message.role === "system") return <p className="chat-system">{message.text}</p>;
  return (
    <AssistantMessage
      message={message}
      links={links}
      reply={reply}
      sources={sources}
      workedFor={workedFor}
      onBranch={onBranch ? () => onBranch(index) : undefined}
      onRegenerate={onRegenerate}
    />
  );
});
function sourceLabel(projection: RuntimeProjection, sourceThreadId: ThreadId | undefined): string {
  const thread = projection.threads.find((candidate) => candidate.threadId === sourceThreadId);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread?.worktreeId);
  if (!worktree) return "From another agent";
  return `From another agent, ${worktree.branch}`;
}

/**
 * A new chat opens straight onto the message box, like any chat app. The agent may still be starting; the
 * header says so, and a message sent meanwhile waits until it is up.
 */
/** The empty chat: the agent's mark and one question, so the first thing to do is type the task. */
export function ChatStart({
  provider,
  folder,
  onStartFromIssue,
}: {
  provider: string;
  folder: string | undefined;
  /** Offers a quiet "Start from an issue" under the question. */
  onStartFromIssue?: (() => void) | undefined;
}) {
  return (
    <div className="chat-start">
      <ProviderMark provider={provider} size={28} />
      <h2 className="chat-start-title">
        What should we work on
        {folder ? (
          <>
            {" "}
            in <span className="chat-start-folder">{folder}</span>
          </>
        ) : null}
        ?
      </h2>
      {onStartFromIssue ? (
        <button type="button" className="chat-start-issue" onClick={onStartFromIssue}>
          <Icon name="issue" size={13} />
          Start from an issue
        </button>
      ) : null}
    </div>
  );
}

/** The turn the conversation is on: the latest turn any message belongs to. */
function lastTurnId(messages: readonly ThreadMessageProjection[]): string | undefined {
  return messages.findLast((message) => message.turnId)?.turnId;
}

/** A short name for the chat, from its first message, for the chats branched from it. */
function displayTitle(messages: readonly ThreadMessageProjection[]): string {
  const first = messages.find((message) => message.role === "user" && message.text.trim())?.text.trim() ?? "a chat";
  const line = splitAttachedContext(splitAttachedFiles(first).text).body.split(/\r?\n/u)[0]?.trim() || "a chat";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Rows a long chat draws at first, and how many more each step up adds. */
const ROW_WINDOW = 60;

/**
 * Sits above the drawn rows of a long chat. Coming near it while scrolling up draws older rows; the button
 * does the same for keyboard and screen reader users.
 */
function EarlierRows({ rootRef, onShow }: { rootRef: { current: HTMLElement | null }; onShow: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && onShow(), {
      root: rootRef.current,
      rootMargin: "600px 0px 0px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onShow, rootRef]);
  return (
    <div ref={ref} className="chat-earlier">
      <Button size="sm" onClick={onShow}>
        Show earlier messages
      </Button>
    </div>
  );
}
