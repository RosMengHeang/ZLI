import {
  agentNameKey,
  isListedThreadStatus,
  type PermissionMode,
  type RuntimeProjection,
  type ThreadActivityProjection,
  type ThreadCheckpoint,
  type ThreadId,
  type ThreadMessageProjection,
  type ThreadProjection,
  type ThreadQueuedMessage,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import {
  type CSSProperties,
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
import { createPortal } from "react-dom";

import { isSelectableProvider, listedDiscoveries, providerDisplayName, signInCommand } from "../agent/providers.js";
import { type FileLinks, useFileIndexContext, useFileLinks } from "../files/FileIndex.js";
import { useCopyFeedback } from "../review/links.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { entriesForThread, entriesForThreads, entriesInOrder, shallowArrayEqual } from "../runtime/runtimeStore.js";
import { forkPointAfter, type RunAgent, type RunStart } from "../sessions/bestOf.js";
import { takeoverContext } from "../sessions/handoff.js";
import type { ChatPlace } from "../sessions/launch.js";
import { buildTimeline, conversationThreads, type TimelineItem } from "../sessions/sessions.js";
import { useAppSettings } from "../settings/appSettings.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { useChatBuddy } from "../teammates/chatBuddies.js";
import { type Buddy, buddyHex, buddyName } from "../teammates/buddies.js";
import {
  defaultBuddy,
  freeAgentName,
  freeBuddy,
  leadingMentions,
  roomBuddies,
  teammateNamed,
} from "../teammates/teammates.js";
import { Button, IconButton } from "../ui/Button.js";
import { Collapse } from "../ui/Collapse.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Menu, type MenuItem, type MenuRequest } from "../ui/Menu.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { latestContext } from "../usage/usage.js";
import { discoverProviders } from "../welcome/welcomeClient.js";
import { accountPlan, otherAgents } from "./agentModels.js";
import { fileName, splitAttachedFiles } from "./attachedFiles.js";
import type { BestOfAgentOption } from "./BestOfPopover.js";
import {
  ContinueRow,
  FollowUps,
  followUpsIn,
  PlanApproval,
  PlanCard,
  PullRequestStrip,
  ReviewCard,
  reviewFindings,
  SideChat,
  StartSuggestions,
} from "./ChatExtras.js";
import { ChatImage, ChatImageScope, isImagePath } from "./ChatImage.js";
import { Composer, type ComposerAttachment, type ComposerBestOf } from "./Composer.js";
import { ConnectorCard } from "./ConnectorCard.js";
import { clearCodeReferences, removeCodeReference, useCodeReferences } from "./codeReferences.js";
import { FileBadge } from "./FileBadge.js";
import { Markdown } from "./Markdown.js";
import type { MentionOption } from "./MentionPicker.js";
import { RequestCard } from "./RequestCard.js";
import { RoomBar, RoomLive, type RoomPerson, RoomSpeaker } from "./RoomParts.js";
import { reasoningLevels } from "./reasoning.js";
import { mergeRoomTimeline, missedBy, roomBrief, roomGuests, roomHelpers, runningStep } from "./room.js";
import { isSideChat } from "./sideChats.js";
import { isSwitchNotice, switchNotice } from "./switchNotice.js";
import { TurnChanges } from "./TurnChanges.js";
import { TurnRail } from "./TurnRail.js";
import { groupTurns, trailSummary } from "./turns.js";
import { ChangedFiles, elapsedLabel, WorkSteps } from "./WorkLog.js";
import { WorkspaceBar } from "./WorkspaceBar.js";
import "./chat.css";

export function ChatView({
  projection,
  thread,
  worktree,
  onOpenDiff,
  onRestart,
  onHandoff,
  onSwitchAgent,
  onMoveChat,
  onAddFolder,
  onOpenConnectors,
  onStartRuns,
  onBringIn,
  onOpenAgent,
  onManageTeammates,
  onBranch,
  onNewChatWithPrompt,
  onAskAside,
  onCloseAside,
  sideChatSlot,
  active,
}: {
  projection: RuntimeProjection;
  thread: ThreadProjection;
  worktree: WorktreeProjection | undefined;
  onOpenDiff(path?: string): void;
  onRestart(): void;
  onHandoff?: (() => void) | undefined;
  /**
   * Starts this chat over with another agent, before anything was sent. Absent where the tile cannot
   * start agents, such as a scratch chat.
   */
  onSwitchAgent?: ((provider: string, model: string | undefined) => Promise<string | undefined>) | undefined;
  /** Moves the chat to another folder, worktree, or branch before its first message. */
  onMoveChat?: ((place: ChatPlace) => Promise<string | undefined>) | undefined;
  /** Opens the folder picker and adds the folder as a project, for the project menu before the first message. */
  onAddFolder?: (() => Promise<string | undefined>) | undefined;
  /** Opens Settings at a connector, a catalog id or a server name. */
  onOpenConnectors?: ((connectorId?: string) => void) | undefined;
  /** Starts best-of runs from this chat. Absent where runs cannot start, such as a scratch chat. */
  onStartRuns?: ((request: StartRunsRequest) => Promise<string | undefined>) | undefined;
  /** Starts another agent inside this chat. Absent where agents cannot start from here, such as a scratch chat. */
  onBringIn?: ((request: GuestRequest) => Promise<{ threadId: string } | { error: string }>) | undefined;
  /** Shows an agent's own chat or terminal, found by its thread or terminal id. */
  onOpenAgent?: ((agentId: string) => void) | undefined;
  /** Opens Settings at the saved teammates. */
  onManageTeammates?: (() => void) | undefined;
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
  /** The right panel is showing the side chat: the side question is drawn there instead of on the message box. */
  sideChatSlot?: HTMLElement | undefined;
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
  const [peerDraft, setPeerDraft] = useState("");
  const [peerTargetId, setPeerTargetId] = useState<string>();
  const logRef = useRef<HTMLDivElement>(null);
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
  const request = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => value?.requests?.find((candidate) => candidate.threadId === threadId),
      [threadId],
    ),
  );
  const waitingCount = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) =>
        (value?.requests ?? []).filter((candidate) => candidate.threadId === threadId).length,
      [threadId],
    ),
  );
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
  const context = useMemo(() => latestContext(usage), [usage]);
  // A chat that moved to another agent or model is one conversation across the threads it went through.
  const chain = useMemo(() => conversationThreads(thread, projection.threads), [thread, projection.threads]);
  const earlierKey = chain
    .slice(0, -1)
    .map((entry) => entry.threadId)
    .join(" ");
  // Every turn of the conversation keeps its file changes and its point to try again from, whichever
  // agent ran it.
  const chainKey = earlierKey ? `${earlierKey} ${threadId}` : threadId;
  // The agents the person brought into this chat talk in it, so the chat reads as one room.
  const { teammates } = useAppSettings();
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
  const guestRequest = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) =>
        guestKey ? value?.requests?.find((candidate) => guestKey.split(" ").includes(candidate.threadId)) : undefined,
      [guestKey],
    ),
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
    for (const entry of chain) {
      const own = entry.threadId === threadId;
      const said = own ? messages : earlierMessages.filter((message) => message.threadId === entry.threadId);
      const done = own ? activities : earlierActivities.filter((activity) => activity.threadId === entry.threadId);
      // A thread nobody wrote in adds nothing to read, so the notice spans it.
      if (!own && said.length === 0 && done.length === 0) continue;
      if (before) items.push({ kind: "message", message: switchNotice(before, entry, projection.providers) });
      items.push(...buildTimeline(said, done, previousTimeline.current));
      before = entry;
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
      if (candidate.threadId === thread.threadId) return false;
      if (candidate.status === "stopped" || candidate.status === "failed") return false;
      if (candidate.sessionId && isSideChat(candidate.sessionId)) return false;
      const peerWorktree = projection.worktrees.find((item) => item.worktreeId === candidate.worktreeId);
      return peerWorktree?.projectId === worktree.projectId;
    });
  }, [projection.threads, projection.worktrees, thread.threadId, worktree]);
  const selectedPeerId = peers.some((peer) => peer.threadId === peerTargetId) ? peerTargetId : peers[0]?.threadId;
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
    attachments: ComposerAttachment[],
    options: { permissionMode?: PermissionMode; note?: string } = {},
  ): Promise<boolean> => {
    setError(undefined);
    // The first message to an agent that took the chat over brings it the conversation so far. The chat
    // shows the message alone.
    const takeover =
      earlierMessages.length > 0 && queued.length === 0 && !messages.some((message) => message.role === "user")
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

  const sendToPeer = async () => {
    if (!selectedPeerId || !peerDraft.trim()) return;
    const text = peerDraft.trim();
    setPeerDraft("");
    setError(undefined);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: {
        type: "thread.a2a",
        messageId: makeCommandId(),
        sourceThreadId: thread.threadId,
        targetThreadId: selectedPeerId,
        text,
      },
    });
    if (response?.accepted === false) {
      setPeerDraft(text);
      setError(response.error.message);
    }
  };

  const [retry, setRetry] = useState<{ key: string; text: string; index: number }>();
  const placedRef = useRef(placedCheckpoints);
  placedRef.current = placedCheckpoints;
  const worktreeIdRef = useRef(thread.worktreeId);
  worktreeIdRef.current = thread.worktreeId;
  const tryWays = useCallback((message: ThreadMessageProjection, index: number) => {
    setRetry({ key: message.messageId, text: message.text, index });
  }, []);
  // Worked out when the runs start rather than when the popover opens: a turn that just ended may
  // not have its checkpoint yet, and without it the runs would copy the files later turns changed.
  const retryStart = (index: number): RunStart => {
    const checkpoint = forkPointAfter(index, placedRef.current.after);
    return checkpoint
      ? { kind: "checkpoint", checkpointId: checkpoint.checkpointId }
      : { kind: "worktree", worktreeId: worktreeIdRef.current };
  };
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
          retry: retry ? { key: retry.key, text: retry.text } : undefined,
          onRetryClose: () => setRetry(undefined),
          onStart: ({ text, runs, retry: again }) =>
            onStartRuns({
              prompt: text,
              runs,
              from: again && retry ? retryStart(retry.index) : { kind: "worktree", worktreeId: thread.worktreeId },
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
  // A running step already shimmers in the list, so the line under it only says that work goes on.
  const liveLabel = thread.status === "waiting" ? `${displayName} is waiting for you` : step ? "Working" : "Thinking";
  const visibleError = error;
  // Until the first message, the chat is not tied to its agent yet, so the model list offers every agent.
  const fresh = messages.length === 0 && earlierMessages.length === 0 && queued.length === 0 && !ended;
  // A started chat can move too: the pick opens a new chat in the tile that carries the conversation so far.
  // Not while the agent works, so a click in the model list never cuts off a reply.
  const switchable = onSwitchAgent !== undefined && !working && queued.length === 0;
  const modelLocked = thread.capabilities.modelSwitch === "unsupported" && messages.length > 0;
  const others = useMemo(
    () => (switchable ? otherAgents(projection.providers, thread.provider) : []),
    [switchable, projection.providers, thread.provider],
  );
  const agentName = providerDisplayName(thread.provider, projection.providers);
  const signedOut = discovery?.status === "found" && discovery.login?.status === "signed-out";
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
  const [insertRequest, setInsertRequest] = useState<{ text: string; nonce: number; replace?: boolean }>();
  const callOut = (name: string) => setInsertRequest({ text: `@${name} `, nonce: Date.now() });
  const bringIn = async (
    request: GuestRequest,
    announce: boolean,
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
    if (announce) callOut(name);
    return { threadId: result.threadId, name };
  };
  const nextBuddy = (provider: string): Buddy => freeBuddy(provider, buddies.values());
  const presentNames = new Set(
    people.filter((person) => person.role !== "host").map((person) => agentNameKey(person.name)),
  );
  // Bring in opens from the + menu of the message box, anchored to the + button that opened it.
  const [bringMenu, setBringMenu] = useState<MenuRequest>();
  const [peerOpen, setPeerOpen] = useState(false);
  const bringInItems =
    onBringIn && canSend && worktree
      ? (): MenuItem[] => {
          const items: MenuItem[] = [];
          const saved = teammates.filter((teammate) => !presentNames.has(agentNameKey(teammate.name)));
          if (saved.length > 0) {
            items.push({ heading: "Your teammates" });
            for (const teammate of saved) {
              items.push({
                id: `teammate-${teammate.id}`,
                label: teammate.name,
                media: <BuddyAvatar buddy={teammate.buddy} provider={teammate.provider} size={20} />,
                title: `${providerDisplayName(teammate.provider, projection.providers)}${teammate.model ? `, ${teammate.model}` : ""}`,
                run: () =>
                  void bringIn(
                    {
                      provider: teammate.provider,
                      name: teammate.name,
                      ...(teammate.model ? { model: teammate.model } : {}),
                      ...(teammate.permissionMode ? { permissionMode: teammate.permissionMode } : {}),
                    },
                    true,
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
                title: `Joins as ${buddyName(buddy)}`,
                run: () => void bringIn({ provider: entry.provider, name: buddyName(buddy) }, true),
              });
            }
          }
          if (onManageTeammates) {
            items.push({ separator: true });
            items.push({
              id: "teammates",
              label: teammates.length > 0 ? "Edit teammates" : "Save a teammate",
              icon: "users",
              run: onManageTeammates,
            });
          }
          return items;
        }
      : undefined;
  const personItems = (person: RoomPerson): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!person.terminal) {
      items.push({ id: "call", label: `Message ${person.name}`, icon: "message", run: () => callOut(person.name) });
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
    const saved = onBringIn
      ? teammates
          .filter((teammate) => !present.has(agentNameKey(teammate.name)))
          .map((teammate) => ({
            name: teammate.name,
            buddy: teammate.buddy,
            provider: teammate.provider,
            detail: `${providerDisplayName(teammate.provider, projection.providers)} · joins when you send`,
          }))
      : [];
    return [...inChat, ...saved];
  }, [people, teammates, onBringIn, projection.providers]);

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
   * A message that opens with @Name goes to that member of the chat, or brings the saved teammate of that name
   * in first. Anything else goes to the chat's own agent.
   */
  const send = async (text: string, attachments: ComposerAttachment[]): Promise<boolean> => {
    setError(undefined);
    // "/btw question" asks beside the chat instead of in it.
    const aside = /^\/btw\b\s*/iu.exec(text.trim());
    if (aside) {
      openAside(text.trim().slice(aside[0].length));
      return true;
    }
    const callable = people.filter((person) => person.role !== "host" && !person.terminal);
    const saved = onBringIn
      ? teammates.filter(
          (teammate) => !callable.some((person) => agentNameKey(person.name) === agentNameKey(teammate.name)),
        )
      : [];
    const { names } = leadingMentions(text, [
      ...callable.map((person) => person.name),
      ...saved.map((entry) => entry.name),
    ]);
    if (names.length === 0) {
      const note = editing
        ? "The person edited their previous message. This message replaces it: follow this version, and undo or drop what you did for the earlier one where it no longer applies."
        : undefined;
      const sent = await sendToHost(text, attachments, note ? { note } : {});
      if (sent) setEditing(undefined);
      return sent;
    }
    let sent = true;
    for (const called of names) {
      const target = callable.find((person) => agentNameKey(person.name) === agentNameKey(called));
      let targetId = target?.id;
      let name = target?.name ?? called;
      let joining = false;
      let instructions = teammateNamed(teammates, name)?.instructions;
      if (!target) {
        const teammate = teammateNamed(teammates, called);
        if (!teammate) continue;
        const started = await bringIn(
          {
            provider: teammate.provider,
            name: teammate.name,
            ...(teammate.model ? { model: teammate.model } : {}),
            ...(teammate.permissionMode ? { permissionMode: teammate.permissionMode } : {}),
          },
          false,
        );
        if (!started) {
          sent = false;
          continue;
        }
        targetId = started.threadId;
        name = started.name;
        joining = true;
        instructions = teammate.instructions;
      } else if (target.role === "guest") {
        joining = !roomMessages.some((message) => message.threadId === target.id && message.role === "user");
      }
      if (!targetId) continue;
      const id = targetId;
      const context =
        target?.role === "helper"
          ? undefined
          : roomBrief({
              name,
              joining,
              others: people.filter((person) => person.id !== id && !person.terminal).map((person) => person.name),
              branch: worktree?.branch ?? "the current branch",
              missed: missedBy(new Set([id]), roomMessages),
              nameOf: speakerName,
              instructions,
            });
      sent = (await queueTo(id, text, attachments, context)) && sent;
    }
    return sent;
  };
  const guestOfRequest = guestRequest ? guests.find((guest) => guest.threadId === guestRequest.threadId) : undefined;
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
  // or a step never finished.
  const cutOff =
    resumable &&
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

  // Editing the last message puts it back in the box; the next send replaces it.
  const [editing, setEditing] = useState<string>();
  const lastUserIndex = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item?.kind === "message" && item.message.role === "user") return index;
    }
    return -1;
  }, [timeline]);
  const editMessage = useCallback((message: ThreadMessageProjection) => {
    setEditing(message.messageId);
    setInsertRequest({ text: splitAttachedFiles(message.text).text, nonce: Date.now(), replace: true });
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
    setAside(undefined);
  }, [onCloseAside]);
  const askAside = async (question: string) => {
    const current = asideRef.current;
    if (current?.threadId) {
      setAside({ ...current, error: undefined });
      const ok = await queueTo(current.threadId, question, [], undefined);
      if (!ok) setAside((value) => (value ? { ...value, error: "The question could not be sent." } : value));
      return;
    }
    if (!onAskAside) return;
    setAside({ starting: true });
    const context = takeoverContext({
      branch: worktree?.branch ?? "the current branch",
      messages: roomMessages.filter((message) => message.role === "user" || message.role === "assistant"),
      nameOf: speakerName,
    });
    const note =
      "This is a side question about the conversation above. Answer it briefly. Do not change any files or run anything that changes state.";
    const started = await onAskAside(question, [context, note].filter(Boolean).join("\n\n"));
    setAside(
      "error" in started ? { starting: false, error: started.error } : { starting: false, threadId: started.threadId },
    );
  };
  const openAside = (question: string) => {
    if (!onAskAside) return;
    if (!asideRef.current) setAside({ starting: false });
    if (question.trim()) void askAside(question.trim());
  };
  // Ctrl+; (Cmd+; on a Mac) opens a side question in the chat in focus.
  useEffect(() => {
    if (!active || !onAskAside) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === ";" && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        setAside((current) => current ?? { starting: false });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onAskAside]);

  const renderItem = (index: number, withChanges: boolean) => {
    const item = timeline[index];
    if (!item) return null;
    return (
      <Fragment key={item.kind === "work" ? `work-${item.key}` : (item.key ?? item.message.messageId)}>
        {item.kind === "work" ? (
          <ChatWork item={item} showChangedFiles={!placedCheckpoints.turns.has(item.turnId)} onOpenDiff={openDiff} />
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
              onTryWays={bestOf && canSend && !guestIds.has(item.message.threadId) ? tryWays : undefined}
              onEdit={
                index === lastUserIndex && settled && item.message.threadId === thread.threadId
                  ? editMessage
                  : undefined
              }
              onBranch={onBranch && !working ? branchAt : undefined}
            />
          </>
        )}
        {withChanges ? placedCheckpoints.after.get(index)?.map(turnChanges) : null}
      </Fragment>
    );
  };

  // What waits on the person sits on the message box, above the workspace tab: the plan the agent keeps, a
  // side question, and the go-ahead for a plan. The nearest to the box is the one to act on.
  // With the side chat open in the right panel, the side question lives there, ready before anything is asked.
  const sideChat =
    aside || sideChatSlot ? (
      <SideChat
        buddy={hostBuddy}
        threadId={aside?.threadId}
        starting={aside?.starting ?? false}
        error={aside?.error}
        onAsk={(question) => void askAside(question)}
        onClose={closeAside}
      />
    ) : null;
  const trayAside = sideChatSlot ? null : sideChat;
  const traySections =
    (showPlan && plan?.todos) || trayAside || (planToApprove && !request) ? (
      <>
        {showPlan && plan?.todos ? (
          <PlanCard todos={plan.todos} working={working} onDismiss={() => setHiddenPlan(planKey)} />
        ) : null}
        {trayAside}
        {planToApprove && !request ? (
          <PlanApproval
            displayName={displayName}
            canSwitch={permissionSwitch}
            onApprove={() => {
              setApprovedAt(lastIndex);
              if (permissionSwitch) setPermissionMode("full-access");
              void sendToHost("Go ahead with the plan.", [], permissionSwitch ? { permissionMode: "full-access" } : {});
            }}
            onChange={() => {
              setApprovedAt(lastIndex);
              setInsertRequest({ text: "Change the plan: ", nonce: Date.now(), replace: true });
            }}
          />
        ) : null}
      </>
    ) : null;

  return (
    <div className="chat-view">
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
              {timeline.length === 0 && earlyMessages.length === 0 ? (
                <>
                  <ChatStart provider={thread.provider} folder={project?.name} buddy={buddies.get(thread.threadId)} />
                  {canSend ? (
                    <StartSuggestions
                      folder={project?.name}
                      onPick={(text) => setInsertRequest({ text, nonce: Date.now(), replace: true })}
                    />
                  ) : null}
                </>
              ) : (
                turns.rows.map((row) =>
                  row.kind === "item" ? (
                    renderItem(row.index, true)
                  ) : (
                    <Fragment key={row.key}>
                      <TurnFold
                        summary={trailSummary(row.activities)}
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
              {followUps.length > 0 && findings.length === 0 ? (
                <FollowUps items={followUps} onHere={(task) => void send(task, [])} onNewChat={onNewChatWithPrompt} />
              ) : null}
              {cutOff ? <ContinueRow onContinue={() => void sendToHost("Continue where you left off.", [])} /> : null}
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
                <WorkingStatus label={liveLabel} live={!step && thread.status !== "waiting"} />
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
      <div className="chat-dock">
        <div className="chat-column">
          {request ? (
            <RequestCard
              key={request.requestId}
              request={request}
              provider={thread.provider}
              displayName={displayName}
              waitingCount={waitingCount}
              onRespond={(decision) =>
                run({ type: "thread.respond", threadId: thread.threadId, requestId: request.requestId, decision })
              }
              onAnswer={(answers) =>
                run({ type: "thread.user-input", threadId: thread.threadId, requestId: request.requestId, answers })
              }
            />
          ) : null}
          {guestRequest && guestOfRequest ? (
            <RequestCard
              key={guestRequest.requestId}
              request={guestRequest}
              provider={guestOfRequest.provider}
              displayName={nameOfThread(guestOfRequest)}
              waitingCount={1}
              onRespond={(decision) =>
                run({
                  type: "thread.respond",
                  threadId: guestRequest.threadId,
                  requestId: guestRequest.requestId,
                  decision,
                })
              }
              onAnswer={(answers) =>
                run({
                  type: "thread.user-input",
                  threadId: guestRequest.threadId,
                  requestId: guestRequest.requestId,
                  answers,
                })
              }
            />
          ) : null}
          {connectorActivity?.connector ? (
            <ConnectorCard
              key={connectorActivity.activityId}
              connector={connectorActivity.connector}
              displayName={displayName}
              onTryAgain={canSend ? (text) => send(text, []) : undefined}
              onNewChat={() => void newChatForConnector()}
              onOpenConnectors={onOpenConnectors}
              onDismiss={() => setDismissedConnectors((current) => new Set(current).add(connectorActivity.activityId))}
            />
          ) : null}
          {queued.length > 0 && earlyMessages.length === 0 ? (
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
          ) : null}
          {signedOut && !ended ? (
            <SignInNotice
              name={agentName}
              command={isSelectableProvider(thread.provider) ? signInCommand(thread.provider) : undefined}
              onCheck={() => discoverProviders(dispatch)}
            />
          ) : null}
          {visibleError ? (
            <p className="inline-error" role="alert">
              {visibleError}
            </p>
          ) : null}
          {/* A stopped chat needs no note: the next message picks up where it left off. A failure says why. */}
          {resumable && thread.status === "failed" && thread.errorMessage ? (
            <p className="chat-paused is-failed" role="status">
              <Icon name="alert" size={12} />
              <span>{thread.errorMessage}</span>
            </p>
          ) : null}
          {editing ? (
            <p className="chat-editing" role="status">
              <Icon name="pencil" size={11} />
              <span>Editing your last message. Sending replaces it.</span>
              <button type="button" onClick={() => setEditing(undefined)}>
                Cancel
              </button>
            </p>
          ) : null}
          <PullRequestStrip
            worktreeId={worktree?.worktreeId}
            displayName={displayName}
            onAsk={canSend ? (text) => void send(text, []) : undefined}
          />
          {sideChatSlot && sideChat ? createPortal(sideChat, sideChatSlot) : null}
          {ended && !resumable && traySections ? <div className="composer-tray is-loose">{traySections}</div> : null}
          {ended && !resumable ? (
            <div className={`chat-ended${thread.status === "failed" ? " is-failed" : ""}`} role="status">
              <Icon name={thread.status === "failed" ? "alert" : "square"} size={13} />
              <span className="chat-ended-copy">
                <span className="chat-ended-title">
                  {thread.status === "failed" ? `${displayName} failed` : `${displayName} session ended`}
                </span>
                <span className="chat-ended-detail">
                  {thread.errorMessage ?? "A new chat starts fresh in the same worktree."}
                </span>
              </span>
              {onHandoff ? (
                <Button
                  size="sm"
                  icon="handoff"
                  tooltip="Start another agent from this conversation"
                  onClick={onHandoff}
                >
                  Switch agent
                </Button>
              ) : null}
              <Button variant="primary" size="sm" icon="plus" onClick={onRestart}>
                New chat
              </Button>
            </div>
          ) : (
            <>
              <RoomBar people={people} bringInItems={bringInItems} bringing={bringing} personItems={personItems} />
              {bringMenu ? <Menu request={bringMenu} onClose={() => setBringMenu(undefined)} /> : null}
              <Composer
                moreAddItems={[
                  ...(bringInItems
                    ? [
                        {
                          id: "bring-in",
                          label: "Bring in an agent",
                          icon: "users" as const,
                          detail: "Another agent or a teammate joins this chat",
                          run: () => {
                            const anchor =
                              document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
                            const rect = anchor?.getBoundingClientRect();
                            setBringMenu({
                              x: rect?.left ?? 0,
                              y: (rect?.bottom ?? 0) + 4,
                              align: "start",
                              anchor,
                              label: "Bring in an agent",
                              items: bringInItems(),
                            });
                          },
                        },
                      ]
                    : []),
                  ...(peers.length > 0 && selectedPeerId
                    ? [
                        {
                          id: "peer",
                          label: "Message another agent",
                          icon: "message" as const,
                          detail: "Send a note to another chat in this project",
                          run: () => setPeerOpen(true),
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
                tray={traySections}
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
                queues={busy}
                models={models}
                model={model}
                modelLocked={modelLocked && !switchable}
                onModelChange={modelLocked && switchable ? (next) => switchAgent(thread.provider, next) : setModel}
                carriesOver={switchable && !fresh}
                agentName={agentName}
                agentPlan={discovery?.status === "found" ? accountPlan(discovery.login) : undefined}
                otherAgents={others}
                onAgentChange={switchable ? switchAgent : undefined}
                reasoningLevels={reasoning.levels}
                defaultReasoning={startingReasoning ?? reasoning.defaultLevel}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={setChosenReasoning}
                permissionMode={permissionMode}
                onPermissionModeChange={permissionSwitch ? setPermissionMode : undefined}
                projectId={worktree?.projectId}
                context={context}
                references={references}
                onRemoveReference={(id) => removeCodeReference(thread.threadId, id)}
                onReferencesSent={() => clearCodeReferences(thread.threadId)}
                onSubmit={send}
                onStop={working ? stopTurn : undefined}
                bestOf={bestOf}
                active={active}
                draftKey={thread.sessionId ?? thread.threadId}
              />
            </>
          )}
          {peerOpen && peers.length > 0 && selectedPeerId && !ended ? (
            <section className="chat-peer" aria-label="Message another agent">
              <header className="chat-peer-head">
                <span>Message another agent</span>
                <IconButton label="Close" icon="x" size="xs" onClick={() => setPeerOpen(false)} />
              </header>
              <form
                aria-label="Send to another agent"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendToPeer();
                }}
              >
                <Select<string>
                  className="input-sm"
                  label="Another thread in this project"
                  value={selectedPeerId}
                  options={peers.map((peer) => ({
                    value: peer.threadId,
                    label: peerOptionLabel(projection, peer.threadId),
                    icon: <ProviderMark provider={peer.provider} size={15} />,
                  }))}
                  onChange={setPeerTargetId}
                />
                <textarea
                  className="textarea"
                  value={peerDraft}
                  onChange={(event) => setPeerDraft(event.target.value)}
                  placeholder="Message for that agent"
                  aria-label="Message for the other agent"
                  rows={2}
                />
                <Button size="sm" type="submit" disabled={!peerDraft.trim()}>
                  Send to agent
                </Button>
              </form>
            </section>
          ) : null}
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
          const preview = typed.text.trim().split(/\r?\n/u)[0] ?? "";
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

/** Mounted for as long as the agent works, so the time counts from the moment the message went out. */
function WorkingStatus({ label, live }: { label: string; live: boolean }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="chat-working">
      <span className={`chat-working-label${live ? " shimmer-text" : ""}`} role="status">
        {label}
      </span>
      <span className="chat-working-time">{elapsedLabel(now - startedAt)}</span>
    </p>
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
}: {
  item: Extract<TimelineItem, { kind: "work" }>;
  /** Off once the turn has a checkpoint, which lists the same files with their real diff. */
  showChangedFiles: boolean;
  onOpenDiff(path?: string): void;
}) {
  // The plan has its own card above the message box, so its updates are not steps.
  const steps = useMemo(() => item.activities.filter((activity) => !activity.todos), [item.activities]);
  if (steps.length === 0 && !(showChangedFiles && item.changedFiles.length > 0)) return null;
  return (
    <div className="chat-work">
      {steps.length > 0 ? <WorkSteps activities={steps} onOpenFile={onOpenDiff} /> : null}
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

/** An agent the person brings into a chat: which agent, its name there, and optionally its model and access. */
export type GuestRequest = {
  provider: string;
  name: string;
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
  open,
  onToggle,
  children,
}: {
  summary: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <section className={`turn-fold${open ? " is-open" : ""}`} aria-label="Steps of an earlier turn">
      <button type="button" className="turn-fold-row" aria-expanded={open} onClick={onToggle}>
        <Icon name="chevronRight" size={11} className="turn-fold-chevron" />
        <span className="turn-fold-summary">{summary}</span>
      </button>
      <Collapse open={open}>
        <div className="turn-fold-body">{children}</div>
      </Collapse>
    </section>
  );
}

/** Past this, a sent message shows its start and opens on request, so a pasted log does not fill the chat. */
const LONG_MESSAGE_LINES = 14;
const LONG_MESSAGE_CHARS = 1_400;

function UserMessage({
  message,
  index,
  links,
  onTryWays,
  onEdit,
}: {
  message: ThreadMessageProjection;
  index: number;
  links: FileLinks | undefined;
  onTryWays?: ((message: ThreadMessageProjection, index: number) => void) | undefined;
  onEdit?: ((message: ThreadMessageProjection) => void) | undefined;
}) {
  const typed = splitAttachedFiles(message.text);
  const uploads = message.attachments ?? [];
  const [copyState, copy] = useCopyFeedback();
  const [expanded, setExpanded] = useState(false);
  const long = typed.text.length > LONG_MESSAGE_CHARS || typed.text.split("\n").length > LONG_MESSAGE_LINES;
  const files = typed.paths.map((path) => ({ path, location: links?.resolve(path) }));
  const pictures = files.flatMap((file) =>
    file.location && isImagePath(file.location.path) ? [file.location.path] : [],
  );
  const sentPictures = uploads.filter((attachment) => attachment.mimeType !== "text/plain");
  const sentFiles = uploads.filter((attachment) => attachment.mimeType === "text/plain");
  return (
    <article className="chat-message chat-message-user" data-turn={message.messageId}>
      <span className="chat-message-actions">
        {onTryWays && message.text.trim() ? (
          <Button
            variant="ghost"
            size="xs"
            icon="split"
            tooltip="Run this message again in new worktrees, from before it was sent"
            onClick={() => onTryWays(message, index)}
          >
            Try N ways
          </Button>
        ) : null}
        {onEdit && typed.text ? (
          <IconButton
            label="Edit message"
            tooltip="Edit and send again"
            icon="pencil"
            size="xs"
            iconSize={12}
            onClick={() => onEdit(message)}
          />
        ) : null}
        {typed.text ? (
          <IconButton
            label="Copy message"
            tooltip={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy message"}
            icon={copyState === "copied" ? "check" : "copy"}
            size="xs"
            iconSize={12}
            onClick={() => copy(typed.text)}
          />
        ) : null}
      </span>
      {pictures.length > 0 || sentPictures.length > 0 ? (
        <div className="chat-attachment-pictures">
          {sentPictures.map((attachment) => (
            <ChatImage
              key={attachment.path}
              source={{ attachment: attachment.path, threadId: message.threadId, name: attachment.name }}
            />
          ))}
          {pictures.map((path) => (
            <ChatImage key={path} source={{ path }} />
          ))}
        </div>
      ) : null}
      {sentFiles.length > 0 || files.length > 0 ? (
        <ul className="chat-attachments" aria-label="Attachments">
          {sentFiles.map((attachment) => (
            <li key={attachment.path} title={attachment.name}>
              <span
                className={`file-badge is-sm ${attachment.mimeType === "text/plain" ? "is-doc" : "is-media"}`}
                aria-hidden="true"
              >
                <Icon name={attachment.mimeType === "text/plain" ? "fileText" : "image"} size={11} />
              </span>
              <span className="chat-attachment-name">{attachment.name}</span>
            </li>
          ))}
          {files.map(({ path, location }) => {
            const label = (
              <>
                <FileBadge path={path} size="sm" />
                <span className="chat-attachment-name">{fileName(path)}</span>
              </>
            );
            return location && links ? (
              <li key={path} className="is-link">
                <button type="button" title={`Open ${location.path}`} onClick={() => links.open(location)}>
                  {label}
                </button>
              </li>
            ) : (
              <li key={path} title={path}>
                {label}
              </li>
            );
          })}
        </ul>
      ) : null}
      {typed.text ? <p className={long && !expanded ? "is-clamped" : undefined}>{typed.text}</p> : null}
      {long ? (
        <button
          type="button"
          className="chat-message-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
    </article>
  );
}

function AssistantMessage({
  message,
  links,
  reply,
  onBranch,
}: {
  message: ThreadMessageProjection;
  links: FileLinks | undefined;
  reply: string | undefined;
  onBranch?: (() => void) | undefined;
}) {
  const [copyState, copy] = useCopyFeedback();
  return (
    <article className="chat-message chat-message-assistant">
      <Markdown text={message.text} links={links} showImages />
      {reply ? (
        <div className="chat-reply-foot">
          <IconButton
            label="Copy reply"
            tooltip={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy reply"}
            icon={copyState === "copied" ? "check" : "copy"}
            size="xs"
            iconSize={12}
            onClick={() => copy(reply)}
          />
          {onBranch ? (
            <IconButton
              label="Branch from here"
              tooltip="New chat from here: it carries the conversation up to this reply"
              icon="branch"
              size="xs"
              iconSize={12}
              onClick={onBranch}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

const ChatMessage = memo(function ChatMessage({
  message,
  index,
  links,
  source,
  reply,
  onTryWays,
  onEdit,
  onBranch,
}: {
  message: ThreadMessageProjection;
  /** Position in the timeline, which places the message among the saved turns. */
  index: number;
  links: FileLinks | undefined;
  source: string;
  /** The turn's whole reply, on its last part only, which offers to copy it. */
  reply?: string | undefined;
  onTryWays?: ((message: ThreadMessageProjection, index: number) => void) | undefined;
  /** Puts the person's last message back in the box to change and send again. */
  onEdit?: ((message: ThreadMessageProjection) => void) | undefined;
  /** Starts a new chat with the conversation up to this reply. */
  onBranch?: ((index: number) => void) | undefined;
}) {
  if (message.role === "user") {
    return <UserMessage message={message} index={index} links={links} onTryWays={onTryWays} onEdit={onEdit} />;
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
      onBranch={onBranch ? () => onBranch(index) : undefined}
    />
  );
});
function sourceLabel(projection: RuntimeProjection, sourceThreadId: ThreadId | undefined): string {
  const thread = projection.threads.find((candidate) => candidate.threadId === sourceThreadId);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread?.worktreeId);
  if (!worktree) return "From another agent";
  return `From another agent, ${worktree.branch}`;
}

function peerOptionLabel(projection: RuntimeProjection, threadId: string): string {
  const thread = projection.threads.find((candidate) => candidate.threadId === threadId);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread?.worktreeId);
  const provider = thread ? providerDisplayName(thread.provider, projection.providers) : "Agent";
  return `${provider} in ${worktree?.branch ?? "a worktree"}`;
}

/**
 * The chat's agent is installed but signed out, so a message would fail. Says what to run and checks
 * again on request; once discovery sees the login, the notice goes away by itself.
 */
function SignInNotice({
  name,
  command,
  onCheck,
}: {
  name: string;
  command: string | undefined;
  onCheck(): Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string>();
  const [copied, setCopied] = useState(false);
  return (
    <div className="chat-ended chat-sign-in" role="status">
      <Icon name="alert" size={13} />
      <span className="chat-ended-copy">
        <span className="chat-ended-title">{name} is signed out</span>
        <span className="chat-ended-detail">
          {command ? (
            <>
              Run <code>{command}</code> in a terminal and sign in, then check again.
            </>
          ) : (
            `Sign in from ${name}'s own CLI, then check again.`
          )}
          {result ? ` ${result}` : null}
        </span>
      </span>
      {command ? (
        <IconButton
          label={`Copy ${command}`}
          tooltip={copied ? "Copied" : "Copy command"}
          icon={copied ? "check" : "copy"}
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(
              () => setCopied(true),
              () => undefined,
            );
          }}
        />
      ) : null}
      <Button
        size="sm"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          setResult(undefined);
          void onCheck().then((outcome) => {
            setChecking(false);
            setResult(outcome.ok ? "Still signed out." : outcome.error);
          });
        }}
      >
        {checking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}

/**
 * A new chat opens straight onto the message box, like any chat app. The agent may still be starting; the
 * header says so, and a message sent meanwhile waits until it is up.
 */
/** The empty chat: the agent's mark and one question, so the first thing to do is type the task. */
export function ChatStart({
  provider,
  folder,
  buddy,
}: {
  provider: string;
  folder: string | undefined;
  /** The chat's own buddy, which stays when the chat moves to another agent. */
  buddy?: Buddy | undefined;
}) {
  return (
    <div className="chat-start">
      {buddy ? (
        <span className="buddy-glow" style={{ "--face": buddyHex(buddy) } as CSSProperties}>
          <BuddyAvatar buddy={buddy} size={92} />
        </span>
      ) : (
        <ProviderMark provider={provider} size={28} />
      )}
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
  const line = splitAttachedFiles(first).text.split(/\r?\n/u)[0]?.trim() || "a chat";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
