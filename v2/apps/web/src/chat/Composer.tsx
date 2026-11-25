import type { AttachmentMimeType, ImageMimeType, PermissionMode, ProviderModelOption } from "@zli-v2/contracts";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { formatFileSize } from "../files/ImagePreview.js";
import { requestIssue } from "../issues/issueRequest.js";
import { issuePrompt } from "../issues/issueStart.js";
import { usePluginContributions } from "../plugins/plugins.js";
import { combinePrompts, requestPromptManager, usePersonalPrompts } from "../prompts/prompts.js";
import { useSharedPrompts } from "../prompts/useSharedPrompts.js";
import { getBridge, type ZliBridge } from "../runtime/bridge.js";
import type { RunAgent } from "../sessions/bestOf.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton, type MenuEntry } from "../ui/Menu.js";
import { DEFAULT_MODEL, modelOptions } from "../ui/ModelMark.js";
import { Picker } from "../ui/Picker.js";
import { StopButton } from "../ui/StopButton.js";
import { AgentModelPicker } from "./AgentModelPicker.js";
import type { AgentChoice } from "./agentModels.js";
import { fileName, parentName, type SkippedFile, skippedFilesMessage, withAttachedFiles } from "./attachedFiles.js";
import { type BestOfAgentOption, BestOfPopover } from "./BestOfPopover.js";
import { ImageViewer } from "./ChatImage.js";
import { CONTEXT_ICONS, useComposerMenu } from "./ComposerMenu.js";
import { CHAT_DRAG_TYPE, readDraggedChat } from "./chatDrag.js";
import { type CodeReference, referenceLabel, withReferences } from "./codeReferences.js";
import {
  addChip,
  type ComposerChip,
  type ComposerCommand,
  type MentionOption,
  personChip,
  withChips,
  withPersonChips,
} from "./composerTriggers.js";
import { moveDraft, readDraft, writeDraft } from "./drafts.js";
import { EffortSlider } from "./EffortSlider.js";
import { FileBadge } from "./FileBadge.js";
import "./composerChips.css";
import {
  attachmentOnlyMessage,
  isLongPaste,
  lineCount,
  MAX_TEXT_ATTACHMENT_BYTES,
  textBase64,
  textByteLength,
} from "./pastedText.js";
import { PermissionIcon, permissionOptionsFor, permissionText } from "./permissions.js";
import { reasoningLabel, reasoningNoun } from "./reasoning.js";

const NO_LEVELS: readonly string[] = [];
const NO_AGENTS: readonly AgentChoice[] = [];

/**
 * Unsent text is kept by chat session (see drafts.ts). Moving a chat to another agent, folder, or branch opens a
 * new thread and a new message box, and the text typed so far comes along instead of being lost.
 */
/** Chats whose seeded text goes out as soon as their message box can send it. */
const sendOnOpen = new Set<string>();

/**
 * Puts text in a chat's message box before it opens, as if it had been typed there. With `send`, the box sends it
 * the moment it is ready, as when the person typed it on the empty screen and pressed Enter.
 */
export function seedComposerDraft(key: string, text: string, options: { send?: boolean } = {}): void {
  writeDraft(key, text);
  if (options.send && text.trim()) sendOnOpen.add(key);
  else sendOnOpen.delete(key);
}

const CapturePicker = lazy(() => import("./CapturePicker.js").then((module) => ({ default: module.CapturePicker })));

export type ComposerAttachment = { name: string; mimeType: AttachmentMimeType; dataBase64: string };

export const BEST_OF_SHORTCUT = "Mod+Shift+Enter";

/** Starting several runs of one message. Absent where the chat cannot start runs. */
export type ComposerBestOf = {
  agents: readonly BestOfAgentOption[];
  current: RunAgent;
  /** Resolves with a message when the runs could not start. */
  onStart(input: { text: string; runs: RunAgent[] }): Promise<string | undefined>;
};

type Draft =
  | { kind: "image"; id: string; file: File; mimeType: ImageMimeType; previewUrl: string }
  | { kind: "text"; id: string; name: string; text: string; lines: number }
  | { kind: "file"; id: string; name: string; path: string; size: number };

type Upload = Exclude<Draft, { kind: "file" }>;

const isUpload = (entry: Draft): entry is Upload => entry.kind !== "file";

const IMAGE_TYPES: readonly ImageMimeType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENTS = 8;
/** Files from disk go out as paths, so they do not count toward the upload limit. */
const MAX_FILES = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function isImageType(value: string): value is ImageMimeType {
  return (IMAGE_TYPES as readonly string[]).includes(value);
}

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}

const NO_MENTIONS: readonly MentionOption[] = [];
const NO_COMMANDS: readonly ComposerCommand[] = [];

export function Composer({
  mentions = NO_MENTIONS,
  insertRequest,
  displayName,
  provider,
  branch,
  workspace,
  chips,
  tray,
  blocked,
  disabled,
  queues = false,
  models,
  model,
  modelLocked,
  onModelChange,
  agentName,
  agentPlan,
  agentAccount,
  otherAgents = NO_AGENTS,
  onAgentChange,
  carriesOver = false,
  reasoningLevels = NO_LEVELS,
  defaultReasoning,
  reasoningEffort,
  fast,
  onFastChange,
  onReasoningEffortChange,
  permissionMode,
  onPermissionModeChange,
  projectId,
  capture,
  references = [],
  onRemoveReference,
  onReferencesSent,
  onSubmit,
  onStop,
  bestOf,
  active = false,
  draftKey,
  peopleItems,
  issueRequest,
  worktreeId,
  commands = NO_COMMANDS,
}: {
  /** Who "@" offers: the chat's other members and the buddies. Empty turns the list off. */
  mentions?: readonly MentionOption[] | undefined;
  /**
   * Text to put at the start of the message box; a new nonce asks again. replace swaps the draft for it, as
   * editing a sent message does. With `mention`, the person goes in as a removable chip instead.
   */
  insertRequest?: { text: string; nonce: number; replace?: boolean; mention?: MentionOption } | undefined;
  displayName: string;
  /** The agent's provider. Its mark stands for the default model. */
  provider?: string | undefined;
  branch: string;
  /** The tab above the message box that says, and before the first message changes, where the agent works. */
  workspace?: ReactNode;
  /** Small chips in the row under the box, beside the workspace: who is in the chat, the branch's pull request. */
  chips?: ReactNode;
  /** What waits on the person, docked above the workspace tab: the plan, a side question, an approval. */
  tray?: ReactNode;
  /** Why the agent cannot take a message right now, shown above the box. Typing still works; sending does not. */
  blocked?: ReactNode;
  disabled: boolean;
  /** The agent is busy, so a submitted message waits in its queue. */
  queues?: boolean;
  models: readonly ProviderModelOption[] | undefined;
  model: string | undefined;
  /** The provider cannot switch models inside a running session. */
  modelLocked: boolean;
  onModelChange(model: string | undefined): void;
  /** The agent's own name, heading its models when other agents are listed too. */
  agentName?: string | undefined;
  /** The plan of the account the agent is signed in to, such as Max or Plus. */
  agentPlan?: string | undefined;
  /**
   * Other installed agents, listed under the chat's own so the chat can move to any of them. Empty while
   * the agent works.
   */
  /** The chat's own login, once its agent has saved accounts. */
  agentAccount?: { id: string; label: string; tag: string } | undefined;
  otherAgents?: readonly AgentChoice[] | undefined;
  onAgentChange?: ((provider: string, model: string | undefined, accountId?: string) => void) | undefined;
  /** The conversation has begun: another agent or model picks it up from the next message. */
  carriesOver?: boolean | undefined;
  /** Levels the current model takes. Empty hides the picker. */
  reasoningLevels?: readonly string[] | undefined;
  /** The model's own level, when the agent says. */
  defaultReasoning?: string | undefined;
  reasoningEffort?: string | undefined;
  /** Whether fast is on. Undefined when the picked model has no faster mode, which hides the switch. */
  fast?: boolean | undefined;
  onFastChange?: ((fast: boolean) => void) | undefined;
  onReasoningEffortChange?(level: string | undefined): void;
  permissionMode: PermissionMode;
  /** Absent when the provider keeps its permission mode for the whole session. */
  onPermissionModeChange?: ((mode: PermissionMode) => void) | undefined;
  /** Where shared prompts come from. */
  projectId: string | undefined;
  /** Window capture from the desktop app. Absent where it is not available. */
  capture?: ZliBridge["capture"] | undefined;
  /** Files and lines picked in the Files panel. They go out ahead of the next message. */
  references?: readonly CodeReference[] | undefined;
  onRemoveReference?(id: string): void;
  onReferencesSent?(): void;
  onSubmit(text: string, attachments: ComposerAttachment[]): Promise<boolean>;
  /** Stops the turn that is running. Absent while the agent is not working. */
  onStop?: (() => void) | undefined;
  bestOf?: ComposerBestOf | undefined;
  /** The tile is the active one, so typing should land here. */
  active?: boolean | undefined;
  /** Keeps the unsent text for this chat when its message box is replaced. */
  draftKey?: string | undefined;
  /** Changes to a new number to open the issue picker, as the new-chat screen's "Start from an issue" does. */
  issueRequest?: number | undefined;
  /**
   * What the chat around the box adds to its "+" menu after the attach items: bringing in or messaging another
   * agent, a side question.
   */
  peopleItems?: readonly Exclude<MenuEntry, "separator">[] | undefined;
  /** The worktree "@" lists files from. */
  worktreeId?: string | undefined;
  /** "/" commands the chat around the box handles, such as starting a new chat. */
  commands?: readonly ComposerCommand[] | undefined;
}) {
  const [draft, setDraft] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  const savedUnder = useRef(draftKey);
  useEffect(() => {
    const previous = savedUnder.current;
    savedUnder.current = draftKey;
    if (!draftKey) return;
    if (previous && previous !== draftKey) moveDraft(previous, draftKey, draft);
    else writeDraft(draftKey, draft);
  }, [draftKey, draft]);
  const [images, setImages] = useState<Draft[]>([]);
  // Teammates, files, skills, and "#" items picked from the menu. They go out with the next message.
  const [picks, setPicks] = useState<ComposerChip[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const sendingNow = useRef(false);
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string }>();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [bestOfOpen, setBestOfOpen] = useState(false);
  const [bestOfStarting, setBestOfStarting] = useState(false);
  const [bestOfError, setBestOfError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A tile goes active on mousedown, and the browser then moves focus to whatever was clicked.
  // Waiting a frame lets the message box have the last word, unless the click went into another
  // field in the same tile, such as a search box.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const focused = document.activeElement;
      const tile = textarea.closest(".agent-tile") ?? document.body;
      if (focused instanceof HTMLElement && focused !== textarea && tile.contains(focused) && takesInput(focused))
        return;
      textarea.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  const personalPrompts = usePersonalPrompts();
  const sharedPrompts = useSharedPrompts(projectId);
  const pluginPrompts = usePluginContributions(draft.startsWith("/")).prompts;
  const prompts = useMemo(
    () => combinePrompts(sharedPrompts.prompts, personalPrompts, pluginPrompts),
    [sharedPrompts.prompts, personalPrompts, pluginPrompts],
  );
  const formRef = useRef<HTMLFormElement>(null);
  const insertNonce = insertRequest?.nonce;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request inserts, not a new text.
  useEffect(() => {
    if (!insertRequest) return;
    const mention = insertRequest.mention;
    if (mention) setPicks((current) => addChip(current, personChip(mention)));
    const text = insertRequest.text;
    if (text || insertRequest.replace)
      setDraft((current) => (insertRequest.replace ? text : text + current.replace(/^@\S+\s*/u, "")));
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [insertNonce]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const others = onAgentChange ? otherAgents : NO_AGENTS;
  const modelLabel = useMemo(
    () =>
      modelOptions(models, model, provider).find((option) => option.value === (model ?? DEFAULT_MODEL))?.label ?? model,
    [models, model, provider],
  );
  const permission = permissionText(provider, permissionMode);
  // One line per level: the name and its icon. What each one allows is in the button's tooltip.
  const permissionChoices = useMemo(
    () => permissionOptionsFor(provider).map(({ description: _, ...option }) => option),
    [provider],
  );
  const noun = reasoningNoun(provider);

  useEffect(
    () => () => {
      for (const image of imagesRef.current) if (image.kind === "image") URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  const addFiles = (files: readonly File[]) => {
    setError(undefined);
    const current = imagesRef.current;
    const known = new Set(current.flatMap((entry) => (entry.kind === "file" ? [entry.path] : [])));
    let uploads = current.filter(isUpload).length;
    let picked = current.length - uploads;
    const added: Draft[] = [];
    const skipped: SkippedFile[] = [];
    for (const file of files) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      const name = file.name || "a file";
      if (isImageType(file.type) && file.size <= MAX_IMAGE_BYTES) {
        if (uploads >= MAX_ATTACHMENTS) {
          skipped.push({ name, reason: `only ${MAX_ATTACHMENTS} images per message` });
          continue;
        }
        uploads += 1;
        added.push({
          kind: "image",
          id,
          file,
          mimeType: file.type,
          previewUrl: typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "",
        });
        continue;
      }
      // Agents read other files from disk, so the message carries the path instead of the bytes.
      const path = getBridge()?.pathForFile?.(file);
      if (!path) {
        skipped.push({
          name,
          reason: isImageType(file.type)
            ? "larger than 10 MB"
            : "only PNG, JPEG, GIF and WebP images can be attached here",
        });
        continue;
      }
      if (known.has(path)) continue;
      if (picked >= MAX_FILES) {
        skipped.push({ name, reason: `only ${MAX_FILES} files per message` });
        continue;
      }
      known.add(path);
      picked += 1;
      added.push({ kind: "file", id, name: file.name || fileName(path), path, size: file.size });
    }
    const problem = skippedFilesMessage(skipped);
    if (problem) setError(problem);
    if (added.length > 0) setImages((existing) => [...existing, ...added]);
  };

  const addPastedText = (text: string, label?: string) => {
    setError(undefined);
    if (textByteLength(text) > MAX_TEXT_ATTACHMENT_BYTES) {
      setError("Pasted text is larger than 10 MB.");
      return;
    }
    setImages((current) => {
      if (current.filter(isUpload).length >= MAX_ATTACHMENTS) {
        setError(`Attach up to ${MAX_ATTACHMENTS} files per message.`);
        return current;
      }
      const number = current.filter((entry) => entry.kind === "text").length + 1;
      return [
        ...current,
        {
          kind: "text",
          id: `pasted-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: label ?? `pasted-text-${number}.txt`,
          text,
          lines: lineCount(text),
        },
      ];
    });
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed?.kind === "image" && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  };

  const inlinePastedText = (id: string) => {
    const entry = images.find((image) => image.id === id);
    if (entry?.kind !== "text") return;
    setDraft((current) => (current ? `${current.replace(/\s+$/u, "")}\n\n${entry.text}` : entry.text));
    removeImage(id);
    textareaRef.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    // The ref turns a second Enter away at once, before the state that disables Send has rendered.
    if (
      (!text && images.length === 0 && references.length === 0 && picks.length === 0) ||
      disabled ||
      blocked ||
      sending ||
      sendingNow.current
    )
      return;
    sendingNow.current = true;
    setSending(true);
    setError(undefined);
    const sentChips = picks;
    try {
      const blocks = await loadChipBlocks(sentChips);
      const uploads = images.filter(isUpload);
      const paths = images.flatMap((image) => (image.kind === "file" ? [image.path] : []));
      const attachments = await Promise.all(
        uploads.map(
          async (image): Promise<ComposerAttachment> =>
            image.kind === "text"
              ? { name: image.name, mimeType: "text/plain", dataBase64: textBase64(image.text) }
              : {
                  name: image.file.name || "image",
                  mimeType: image.mimeType,
                  dataBase64: await readBase64(image.file),
                },
        ),
      );
      setDraft("");
      const texts = uploads.filter((image) => image.kind === "text").length;
      const message =
        text || (images.length > 0 ? attachmentOnlyMessage(uploads.length - texts, texts, paths.length) : "");
      const asked = withChips(message, sentChips, { knownSkills: menu.skillNames, provider, blocks });
      const sent = await onSubmit(
        withPersonChips(sentChips, withReferences(references, withAttachedFiles(paths, asked))),
        attachments,
      );
      if (sent) {
        setPicks((current) => current.filter((chip) => !sentChips.includes(chip)));
        if (references.length > 0) onReferencesSent?.();
        for (const image of images)
          if (image.kind === "image" && image.previewUrl) URL.revokeObjectURL(image.previewUrl);
        setImages([]);
      } else setDraft(text);
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  };

  // Text typed on the empty screen goes out once this box can send, so starting a chat there takes one Enter.
  const sendWhenReady = useRef(draftKey ? sendOnOpen.has(draftKey) : false);
  useEffect(() => {
    if (!sendWhenReady.current || !draftKey || disabled || blocked) return;
    sendWhenReady.current = false;
    sendOnOpen.delete(draftKey);
    void submit({ preventDefault() {} } as FormEvent);
  });

  const openBestOf = () => {
    if (!bestOf) return;
    setBestOfError(undefined);
    setBestOfOpen(true);
  };

  const closeBestOf = () => {
    setBestOfOpen(false);
    setBestOfError(undefined);
    textareaRef.current?.focus();
  };

  /** Every run gets the draft as its first message. Pasted text goes inline; images cannot be copied to runs. */
  const startBestOf = async (runs: RunAgent[]) => {
    if (!bestOf || bestOfStarting) return;
    if (images.some((image) => image.kind === "image")) {
      setBestOfError("Runs start from text only. Remove the images, or send them as a normal message.");
      return;
    }
    const pasted = images.flatMap((image) => (image.kind === "text" ? [image.text] : []));
    const paths = images.flatMap((image) => (image.kind === "file" ? [image.path] : []));
    const message = [draft.trim(), ...pasted].filter(Boolean).join("\n\n");
    if (!message && references.length === 0 && paths.length === 0 && picks.length === 0) {
      setBestOfError("Type the message every run starts with.");
      return;
    }
    const sentChips = picks;
    setBestOfStarting(true);
    setBestOfError(undefined);
    try {
      const blocks = await loadChipBlocks(sentChips);
      const asked = withChips(message, sentChips, { knownSkills: menu.skillNames, provider, blocks });
      const text = withPersonChips(sentChips, withReferences(references, withAttachedFiles(paths, asked)));
      const failure = await bestOf.onStart({ text, runs });
      if (failure) {
        setBestOfError(failure);
        return;
      }
      setDraft("");
      setPicks([]);
      if (references.length > 0) onReferencesSent?.();
      setImages([]);
      setBestOfOpen(false);
    } catch (cause) {
      setBestOfError(cause instanceof Error ? cause.message : "The runs could not start.");
    } finally {
      setBestOfStarting(false);
    }
  };
  const bestOfVisible = bestOf !== undefined && bestOfOpen;

  // An issue rides along as a text attachment: its title, link, and description, for the agent to read.
  const pickIssue = () =>
    requestIssue({
      projectId,
      onPick: (issue) => addPastedText(issuePrompt(issue), `${issue.reference}.md`),
    });
  const issueNonce = issueRequest;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce is the request; pickIssue changes every render.
  useEffect(() => {
    if (issueNonce) pickIssue();
  }, [issueNonce]);

  const effortShown = reasoningLevels.length > 0 && onReasoningEffortChange !== undefined;
  // One "+" holds what the footer used to spread out: files, a picture of an open window, an issue, the other
  // agents, a side question, Best of N, and fast mode where the effort popup does not carry it.
  const addItems: MenuEntry[] = [
    { id: "files", label: "Files", icon: "file", run: () => fileInputRef.current?.click() },
    ...(capture ? [{ id: "window", label: "A window", icon: "camera" as const, run: () => setCapturing(true) }] : []),
    ...(projectId ? [{ id: "issue", label: "An issue", icon: "issue" as const, run: pickIssue }] : []),
    ...(peopleItems && peopleItems.length > 0 ? ["separator" as const, ...peopleItems] : []),
    ...(bestOf
      ? [
          "separator" as const,
          {
            id: "best-of",
            label: "Send as Best of N",
            icon: "split" as const,
            title: "Run this message several ways, then keep one",
            shortcut: BEST_OF_SHORTCUT,
            run: openBestOf,
          },
        ]
      : []),
    ...(fast !== undefined && onFastChange && !effortShown
      ? [
          {
            id: "fast",
            label: "Fast mode",
            icon: "zap" as const,
            checked: fast,
            title: "Quicker answers from the same model, billed at a higher rate",
            run: () => onFastChange(!fast),
          },
        ]
      : []),
  ];
  const hasContent = draft.trim() !== "" || images.length > 0 || references.length > 0 || picks.length > 0;

  const plan = permissionText(provider, "read-only");
  const standard = permissionText(provider, "supervised");
  // What "/" offers. Each one is something this box or the chat around it already does.
  const builtInCommands: ComposerCommand[] = [
    ...commands.filter((command) => command.source !== "agent"),
    ...(!modelLocked || others.length > 0
      ? [
          {
            name: "model",
            description: others.length > 0 ? "Pick the agent and model" : "Pick the model",
            run: () => formRef.current?.querySelector<HTMLButtonElement>(".composer-model")?.click(),
          },
        ]
      : []),
    ...(onPermissionModeChange && permissionMode !== "read-only"
      ? [{ name: "plan", description: `${plan.label}. ${plan.hint}`, run: () => onPermissionModeChange("read-only") }]
      : []),
    ...(onPermissionModeChange && permissionMode !== "supervised"
      ? [
          {
            name: "default",
            description: `${standard.label}. ${standard.hint}`,
            run: () => onPermissionModeChange("supervised"),
          },
        ]
      : []),
    ...(fast !== undefined && onFastChange
      ? [
          {
            name: "fast",
            description: fast ? "Turn fast mode off" : "Turn fast mode on: quicker answers, billed at a higher rate",
            run: () => onFastChange(!fast),
          },
        ]
      : []),
    { name: "attach", description: "Attach files from your computer", run: () => fileInputRef.current?.click() },
    ...(capture
      ? [{ name: "window", description: "Attach a picture of an open window", run: () => setCapturing(true) }]
      : []),
    ...(projectId
      ? [{ name: "issue", description: "Attach an issue from the project's tracker", run: pickIssue }]
      : []),
    ...(bestOf
      ? [{ name: "best-of", description: "Run this message several ways, then keep one", run: openBestOf }]
      : []),
    { name: "prompts", description: "Manage saved prompts", run: () => requestPromptManager({ projectId }) },
  ];
  const allCommands = [
    ...builtInCommands.map((command) => ({ ...command, source: "zli" as const })),
    ...commands.filter((command) => command.source === "agent"),
  ];
  const menu = useComposerMenu({
    draft,
    setDraft,
    textareaRef,
    mentions,
    worktreeId,
    projectId,
    provider,
    agentName: agentName ?? displayName,
    commands: allCommands,
    prompts,
    onChip: (chip) => setPicks((current) => addChip(current, chip)),
    currentChat: draftKey,
    promptWarning: sharedPrompts.error,
    promptFooter: (
      <Button
        variant="ghost"
        size="xs"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setDraft("");
          requestPromptManager({ projectId });
        }}
      >
        Manage prompts
      </Button>
    ),
  });
  // The keys that open the menu, named in the placeholder.
  const keyHints = [
    worktreeId ? "@ files" : mentions.length > 0 ? "@ buddies" : undefined,
    worktreeId || projectId ? "# context" : undefined,
    "$ skills",
    "/ commands",
  ]
    .filter(Boolean)
    .join(", ");

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (!isLongPaste(pasted)) return;
    event.preventDefault();
    addPastedText(pasted);
  };

  // Files from the computer, or a chat dragged from the sidebar, which goes along as context.
  const carriesFiles = (event: DragEvent) =>
    [...event.dataTransfer.types].some((type) => type === "Files" || type === CHAT_DRAG_TYPE);

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    dragDepth.current = 0;
    setDragging(false);
    if ([...event.dataTransfer.types].includes(CHAT_DRAG_TYPE)) {
      const chat = readDraggedChat(event.dataTransfer);
      if (!chat) return;
      event.preventDefault();
      const slug =
        chat.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-|-$/gu, "")
          .slice(0, 40) || "chat";
      addPastedText(chat.transcript, `chat-${slug}.md`);
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <div
      className={`composer-shell${workspace ? " has-workspace" : ""}${tray || blocked ? " has-tray" : ""}${onStop ? " is-working" : ""}`}
    >
      {tray || blocked ? (
        <div className="composer-tray">
          {blocked}
          {tray}
        </div>
      ) : null}
      <form
        ref={formRef}
        className={`composer prompt-anchor${dragging ? " is-dragging" : ""}`}
        onSubmit={(event) => void submit(event)}
        onDragEnter={(event) => {
          if (!carriesFiles(event)) return;
          // Enter and leave fire for every child the pointer crosses, so only the outermost pair counts.
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!carriesFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDragOver={(event) => {
          if (carriesFiles(event)) event.preventDefault();
        }}
        onDrop={onDrop}
      >
        {dragging ? (
          <div className="composer-drop" aria-hidden="true">
            <Icon name="paperclip" size={16} />
            Drop to attach
          </div>
        ) : null}
        {preview ? <ImageViewer source={preview} onClose={() => setPreview(undefined)} /> : null}
        {bestOfVisible && bestOf ? (
          <BestOfPopover
            agents={bestOf.agents}
            current={bestOf.current}
            starting={bestOfStarting}
            error={bestOfError}
            onStart={(runs) => void startBestOf(runs)}
            onClose={closeBestOf}
          />
        ) : null}
        {capturing && capture ? (
          <Suspense fallback={null}>
            <CapturePicker
              capture={capture}
              onPick={(file) => {
                addFiles([file]);
                setCapturing(false);
                textareaRef.current?.focus();
              }}
              onClose={() => {
                setCapturing(false);
                textareaRef.current?.focus();
              }}
            />
          </Suspense>
        ) : null}
        {images.length > 0 || references.length > 0 ? (
          <ul className="composer-attachments" aria-label="Attachments">
            {references.map((reference) => {
              const label = referenceLabel(reference);
              const folder = reference.path.slice(0, Math.max(0, reference.path.lastIndexOf("/")));
              return (
                <li
                  className="composer-attachment is-card"
                  key={reference.id}
                  title={reference.snippet ? reference.snippet.slice(0, 400) : reference.path}
                >
                  <span className="file-badge is-code" aria-hidden="true">
                    <Icon name="code" size={14} />
                  </span>
                  <span className="composer-attachment-label">
                    <span className="is-mono">{label}</span>
                    <span className="composer-attachment-meta">{folder || "Worktree root"}</span>
                  </span>
                  <RemoveAttachment name={label} onRemove={() => onRemoveReference?.(reference.id)} />
                </li>
              );
            })}
            {images.map((image) => {
              if (image.kind === "text") {
                return (
                  <li className="composer-attachment is-card" key={image.id} title={image.text.slice(0, 400)}>
                    <span className="file-badge is-doc" aria-hidden="true">
                      <Icon name="fileText" size={14} />
                    </span>
                    <span className="composer-attachment-label">
                      <span>{image.name.startsWith("pasted-text-") ? "Pasted text" : image.name}</span>
                      <span className="composer-attachment-meta">
                        {image.lines === 1 ? "1 line" : `${image.lines.toLocaleString()} lines`}
                      </span>
                    </span>
                    <IconButton
                      label={`Put ${image.name} back in the message`}
                      tooltip="Put it back in the message"
                      icon="pencil"
                      size="xs"
                      iconSize={11}
                      onClick={() => inlinePastedText(image.id)}
                    />
                    <RemoveAttachment name={image.name} onRemove={() => removeImage(image.id)} />
                  </li>
                );
              }
              if (image.kind === "file") {
                const folder = parentName(image.path);
                return (
                  <li className="composer-attachment is-card" key={image.id} title={image.path}>
                    <FileBadge path={image.path} />
                    <span className="composer-attachment-label">
                      <span>{image.name}</span>
                      <span className="composer-attachment-meta">
                        {[folder, image.size > 0 ? formatFileSize(image.size) : undefined].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <RemoveAttachment name={image.name} onRemove={() => removeImage(image.id)} />
                  </li>
                );
              }
              const name = image.file.name || "image";
              return (
                <li className="composer-attachment is-image" key={image.id} title={name}>
                  {image.previewUrl ? (
                    <button
                      type="button"
                      className="composer-attachment-thumb"
                      aria-label={`Preview ${name}`}
                      onClick={() => setPreview({ url: image.previewUrl, name })}
                    >
                      <img src={image.previewUrl} alt="" draggable={false} />
                      <span className="sr-only">{name}</span>
                    </button>
                  ) : (
                    <span className="composer-attachment-thumb">
                      <Icon name="image" size={16} />
                      <span className="sr-only">{name}</span>
                    </span>
                  )}
                  <RemoveAttachment name={name} onRemove={() => removeImage(image.id)} />
                </li>
              );
            })}
          </ul>
        ) : null}
        {menu.list}
        {picks.length > 0 ? (
          <ul className="composer-chips" aria-label="Picked for this message">
            {picks.map((chip) => (
              <li className={`composer-chip is-${chip.kind}`} key={chip.key} title={chipTitle(chip)}>
                <ChipMark chip={chip} />
                <span className="composer-chip-label">{chip.label}</span>
                <IconButton
                  className="composer-chip-remove"
                  label={`Remove ${chip.label}`}
                  icon="x"
                  size="xs"
                  iconSize={10}
                  onClick={() => {
                    setPicks((current) => current.filter((entry) => entry.key !== chip.key));
                    textareaRef.current?.focus();
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            menu.trackCaret(event);
          }}
          onSelect={menu.trackCaret}
          onPaste={onPaste}
          {...menu.inputProps}
          onKeyDown={(event) => {
            if (menu.onKeyDown(event)) return;
            // The chips sit before the text, so Backspace at its start takes the last one off.
            if (
              event.key === "Backspace" &&
              picks.length > 0 &&
              event.currentTarget.selectionStart === 0 &&
              event.currentTarget.selectionEnd === 0 &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              setPicks((current) => current.slice(0, -1));
              return;
            }
            if (
              bestOf &&
              event.key === "Enter" &&
              event.shiftKey &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              openBestOf();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            workspace || mentions.length > 0
              ? `Ask ${displayName} anything. ${keyHints}`
              : `Ask ${displayName} to change ${branch}. ${keyHints}`
          }
          aria-label={`Message ${displayName}`}
          rows={2}
        />
        <div className="composer-footer">
          {addItems.length > 1 ? (
            <MenuButton
              label="Add"
              tooltip="Attach, bring in an agent, and more"
              icon="plus"
              size="md"
              iconSize={16}
              align="start"
              className="composer-add"
              items={addItems}
            />
          ) : (
            <IconButton
              label="Attach files"
              tooltip="Attach files. You can also paste or drop them"
              icon="plus"
              iconSize={16}
              className="composer-add"
              onClick={() => fileInputRef.current?.click()}
            />
          )}
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          {/* Fast mode is turned on from the "+" menu; while it is on, it shows here so it is never forgotten. */}
          {fast && onFastChange && !effortShown ? (
            <button
              type="button"
              className="composer-fast is-on"
              aria-pressed={fast}
              aria-label="Fast mode"
              data-tooltip="Fast mode is on: quicker answers, billed at a higher rate. Click to turn it off."
              onClick={() => onFastChange(false)}
            >
              <Icon name="zap" size={13} />
              <span>Fast</span>
            </button>
          ) : null}
          <span className="composer-spacer" />
          <AgentModelPicker
            provider={provider}
            agentName={agentName ?? displayName}
            agentPlan={agentPlan}
            agentAccount={agentAccount}
            models={models}
            model={model}
            others={others}
            locked={modelLocked}
            tooltip={
              modelLocked
                ? `${modelLabel}. ${displayName} keeps its model for the whole session.`
                : carriesOver
                  ? "Pick an agent and model. The conversation so far goes with your next message."
                  : others.length > 0
                    ? "Pick the agent and model before you send"
                    : model
                      ? `${modelLabel}. Applies from your next message.`
                      : `The model ${displayName} is set to use. Pick another for your next message.`
            }
            onModelChange={onModelChange}
            onAgentChange={(next, nextModel, accountId) => onAgentChange?.(next, nextModel, accountId)}
          />
          {effortShown ? (
            <EffortSlider
              noun={noun}
              levels={reasoningLevels}
              defaultLevel={defaultReasoning}
              value={reasoningEffort}
              modelLabel={model ? (modelLabel ?? model) : (agentName ?? displayName)}
              tooltip={`${noun}: ${reasoningEffort ? reasoningLabel(reasoningEffort) : "the model's own level"}. ${provider === "claude-code" ? "How hard Claude works on each answer." : "How long the model thinks before it answers."} Applies from your next message.`}
              onChange={onReasoningEffortChange}
              fast={fast}
              onFastChange={onFastChange}
            />
          ) : null}
          {/* While a turn runs, Stop takes Send's place; Send comes back beside it once there is something to queue. */}
          {onStop ? (
            <StopButton
              size="md"
              className="composer-stop"
              label={`Stop ${displayName}`}
              tooltip={`Stop ${displayName}'s current turn`}
              onClick={onStop}
            />
          ) : null}
          {!onStop || hasContent ? (
            <button
              className="send-button"
              type="submit"
              aria-label={queues ? "Queue message" : "Send"}
              data-tooltip={queues ? `Queue. ${displayName} gets it after the current turn` : "Send"}
              data-shortcut="Enter"
              aria-keyshortcuts="Enter"
              disabled={disabled || Boolean(blocked) || sending || !hasContent}
            >
              <Icon name="arrowUp" size={15} />
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="composer-error" role="alert">
            <Icon name="alert" size={12} />
            {error}
          </p>
        ) : null}
      </form>
      <div className="composer-below">
        {workspace}
        {chips}
        {onPermissionModeChange ? (
          <Picker
            label="Permissions"
            className={`composer-permission is-${permissionMode}`}
            value={permissionMode}
            options={permissionChoices}
            onChange={onPermissionModeChange}
            tooltip={`${permission.label}: ${permission.hint} Applies from your next message.`}
          >
            <PermissionIcon mode={permissionMode} />
            <span className="picker-trigger-label">{permission.label}</span>
          </Picker>
        ) : (
          <span
            className={`composer-badge is-${permissionMode}`}
            data-tooltip={`${permission.label}: ${permission.hint} ${displayName} keeps this for the whole chat.`}
          >
            <PermissionIcon mode={permissionMode} />
            <span className="composer-badge-label">{permission.label}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Reads every "#" chip's block, in order. A source that cannot be read stops the send and says which. */
async function loadChipBlocks(chips: readonly ComposerChip[]): Promise<string[]> {
  return Promise.all(
    chips.flatMap((chip) =>
      chip.kind === "context"
        ? [
            chip.choice.load().catch((cause: unknown) => {
              const reason = cause instanceof Error ? ` ${cause.message}` : "";
              throw new Error(`${chip.label} could not be read.${reason}`);
            }),
          ]
        : [],
    ),
  );
}

function chipTitle(chip: ComposerChip): string {
  switch (chip.kind) {
    case "person":
      return `@${chip.option.name}: ${chip.option.detail}`;
    case "file":
      return chip.path;
    case "skill":
      return `Use the ${chip.name} skill`;
    case "context":
      return chip.choice.detail ? `${chip.label} · ${chip.choice.detail}` : chip.label;
  }
}

function ChipMark({ chip }: { chip: ComposerChip }) {
  switch (chip.kind) {
    case "person":
      return <BuddyAvatar buddy={chip.option.buddy} provider={chip.option.provider} size={16} />;
    case "file":
      return <FileBadge path={chip.path} size="sm" />;
    case "skill":
      return <Icon className="composer-chip-icon" name="puzzle" size={12} aria-hidden="true" />;
    case "context":
      return (
        <Icon className="composer-chip-icon" name={CONTEXT_ICONS[chip.choice.kind]} size={12} aria-hidden="true" />
      );
  }
}

/** Sits on the attachment's top-right corner, and shows while the attachment is hovered or focused. */
function RemoveAttachment({ name, onRemove }: { name: string; onRemove(): void }) {
  return (
    <IconButton
      className="composer-attachment-remove"
      label={`Remove ${name}`}
      tooltip="Remove"
      icon="x"
      size="xs"
      iconSize={10}
      onClick={onRemove}
    />
  );
}

const NOT_TYPED_INTO = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

/** A field the person types or picks into, which keeps focus when its tile goes active. */
function takesInput(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return !NOT_TYPED_INTO.has(element.type);
  return element.isContentEditable;
}
