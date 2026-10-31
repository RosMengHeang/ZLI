import type { AttachmentMimeType, ImageMimeType, PermissionMode, ProviderModelOption } from "@zli-v2/contracts";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { formatFileSize } from "../files/ImagePreview.js";
import { usePluginContributions } from "../plugins/plugins.js";
import { PromptList, usePromptPicker } from "../prompts/PromptPicker.js";
import { combinePrompts, requestPromptManager, slashQuery, usePersonalPrompts } from "../prompts/prompts.js";
import { useSharedPrompts } from "../prompts/useSharedPrompts.js";
import { getBridge, type ZliBridge } from "../runtime/bridge.js";
import type { RunAgent } from "../sessions/bestOf.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { MenuButton, type MenuEntry } from "../ui/Menu.js";
import { DEFAULT_MODEL, ModelMark, modelOptions } from "../ui/ModelMark.js";
import { Picker } from "../ui/Picker.js";
import { ariaShortcut } from "../ui/shortcuts.js";
import { StopButton } from "../ui/StopButton.js";
import { formatTokens } from "../usage/usage.js";
import { fileName, parentName, withAttachedFiles } from "./attachedFiles.js";
import { type BestOfAgentOption, BestOfPopover } from "./BestOfPopover.js";
import { ImageViewer } from "./ChatImage.js";
import { type CodeReference, referenceLabel, withReferences } from "./codeReferences.js";
import { FileBadge } from "./FileBadge.js";
import {
  attachmentOnlyMessage,
  isLongPaste,
  lineCount,
  MAX_TEXT_ATTACHMENT_BYTES,
  textBase64,
  textByteLength,
} from "./pastedText.js";
import { PermissionIcon, permissionHint, permissionLabel, permissionOptions } from "./permissions.js";
import { ReasoningMeter } from "./ReasoningMeter.js";
import { DEFAULT_REASONING, reasoningLabel, reasoningOptions } from "./reasoning.js";

const NO_LEVELS: readonly string[] = [];

const CapturePicker = lazy(() => import("./CapturePicker.js").then((module) => ({ default: module.CapturePicker })));

export type ComposerAttachment = { name: string; mimeType: AttachmentMimeType; dataBase64: string };

export const BEST_OF_SHORTCUT = "Mod+Shift+Enter";

/** Starting several runs of one message. Absent where the chat cannot start runs. */
export type ComposerBestOf = {
  agents: readonly BestOfAgentOption[];
  current: RunAgent;
  /** Try N ways on an earlier message: the popover opens for that message instead of the draft. */
  retry?: { key: string; text: string } | undefined;
  onRetryClose(): void;
  /** Resolves with a message when the runs could not start. */
  onStart(input: { text: string; runs: RunAgent[]; retry: boolean }): Promise<string | undefined>;
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

function ContextMeter({ tokens, window }: { tokens: number; window?: number | undefined }) {
  const detail = window
    ? `${formatTokens(tokens)} of ${formatTokens(window)} tokens in context after the last turn`
    : `${formatTokens(tokens)} tokens in context after the last turn`;
  const percent = window ? Math.min(100, Math.round((tokens / window) * 100)) : undefined;
  return (
    <span
      className={`composer-context${percent !== undefined && percent >= 80 ? " is-full" : ""}`}
      data-tooltip={detail}
    >
      <span aria-hidden="true">
        {percent === undefined ? `${formatTokens(tokens)} context` : `${percent}% context`}
      </span>
      <span className="sr-only">{percent === undefined ? detail : `${percent}% of context used. ${detail}`}</span>
    </span>
  );
}

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

export function Composer({
  displayName,
  provider,
  branch,
  disabled,
  queues = false,
  models,
  model,
  modelLocked,
  onModelChange,
  reasoningLevels = NO_LEVELS,
  defaultReasoning,
  reasoningEffort,
  onReasoningEffortChange,
  permissionMode,
  onPermissionModeChange,
  projectId,
  context,
  capture,
  references = [],
  onRemoveReference,
  onReferencesSent,
  onSubmit,
  onStop,
  bestOf,
  active = false,
}: {
  displayName: string;
  /** The agent's provider. Its mark stands for the default model. */
  provider?: string | undefined;
  branch: string;
  disabled: boolean;
  /** The agent is busy, so a submitted message waits in its queue. */
  queues?: boolean;
  models: readonly ProviderModelOption[] | undefined;
  model: string | undefined;
  /** The provider cannot switch models inside a running session. */
  modelLocked: boolean;
  onModelChange(model: string | undefined): void;
  /** Levels the current model takes. Empty hides the picker. */
  reasoningLevels?: readonly string[] | undefined;
  /** The model's own level, when the agent says. */
  defaultReasoning?: string | undefined;
  reasoningEffort?: string | undefined;
  onReasoningEffortChange?(level: string | undefined): void;
  permissionMode: PermissionMode;
  /** Absent when the provider keeps its permission mode for the whole session. */
  onPermissionModeChange?: ((mode: PermissionMode) => void) | undefined;
  /** Where shared prompts come from. */
  projectId: string | undefined;
  /** How full the context window was after the agent's latest turn, when it reports that. */
  context?: { tokens: number; window?: number } | undefined;
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
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Draft[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string }>();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [bestOfOpen, setBestOfOpen] = useState(false);
  const [bestOfStarting, setBestOfStarting] = useState(false);
  const [bestOfError, setBestOfError] = useState<string>();
  const sendSplitRef = useRef<HTMLSpanElement>(null);
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
  const pluginPrompts = usePluginContributions(slashQuery(draft) !== undefined).prompts;
  const prompts = useMemo(
    () => combinePrompts(sharedPrompts.prompts, personalPrompts, pluginPrompts),
    [sharedPrompts.prompts, personalPrompts, pluginPrompts],
  );
  const picker = usePromptPicker({ draft, setDraft, prompts });
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const modelChoices = useMemo(() => modelOptions(models, model, provider), [models, model, provider]);
  const modelLabel = modelChoices.find((option) => option.value === (model ?? DEFAULT_MODEL))?.label ?? model;
  const reasoningChoices = useMemo(
    () =>
      reasoningOptions(reasoningLevels, defaultReasoning).map((option) => ({
        ...option,
        icon: <ReasoningMeter level={option.value || defaultReasoning} />,
      })),
    [reasoningLevels, defaultReasoning],
  );

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
    let problem: string | undefined;
    for (const file of files) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      if (isImageType(file.type) && file.size <= MAX_IMAGE_BYTES) {
        if (uploads >= MAX_ATTACHMENTS) {
          problem = `Attach up to ${MAX_ATTACHMENTS} images per message.`;
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
        problem = isImageType(file.type)
          ? `${file.name} is larger than 10 MB.`
          : "Only PNG, JPEG, GIF, and WebP images can be attached.";
        continue;
      }
      if (known.has(path)) continue;
      if (picked >= MAX_FILES) {
        problem = `Attach up to ${MAX_FILES} files per message.`;
        continue;
      }
      known.add(path);
      picked += 1;
      added.push({ kind: "file", id, name: file.name || fileName(path), path, size: file.size });
    }
    if (problem) setError(problem);
    if (added.length > 0) setImages((existing) => [...existing, ...added]);
  };

  const addPastedText = (text: string) => {
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
          name: `pasted-text-${number}.txt`,
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
    if ((!text && images.length === 0 && references.length === 0) || disabled || sending) return;
    setSending(true);
    setError(undefined);
    try {
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
      const sent = await onSubmit(withReferences(references, withAttachedFiles(paths, message)), attachments);
      if (sent) {
        if (references.length > 0) onReferencesSent?.();
        for (const image of images)
          if (image.kind === "image" && image.previewUrl) URL.revokeObjectURL(image.previewUrl);
        setImages([]);
      } else setDraft(text);
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!sendMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !sendSplitRef.current?.contains(event.target)) setSendMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [sendMenuOpen]);

  const openBestOf = () => {
    setSendMenuOpen(false);
    if (!bestOf) return;
    bestOf.onRetryClose();
    setBestOfError(undefined);
    setBestOfOpen(true);
  };

  const closeBestOf = () => {
    setBestOfOpen(false);
    setBestOfError(undefined);
    bestOf?.onRetryClose();
    textareaRef.current?.focus();
  };

  /** Every run gets the draft as its first message. Pasted text goes inline; images cannot be copied to runs. */
  const startBestOf = async (runs: RunAgent[]) => {
    if (!bestOf || bestOfStarting) return;
    const retry = bestOf.retry;
    let text: string;
    if (retry) text = retry.text;
    else {
      if (images.some((image) => image.kind === "image")) {
        setBestOfError("Runs start from text only. Remove the images, or send them as a normal message.");
        return;
      }
      const pasted = images.flatMap((image) => (image.kind === "text" ? [image.text] : []));
      const paths = images.flatMap((image) => (image.kind === "file" ? [image.path] : []));
      const message = [draft.trim(), ...pasted].filter(Boolean).join("\n\n");
      if (!message && references.length === 0 && paths.length === 0) {
        setBestOfError("Type the message every run starts with.");
        return;
      }
      text = withReferences(references, withAttachedFiles(paths, message));
    }
    setBestOfStarting(true);
    setBestOfError(undefined);
    try {
      const failure = await bestOf.onStart({ text, runs, retry: retry !== undefined });
      if (failure) {
        setBestOfError(failure);
        return;
      }
      if (retry) bestOf.onRetryClose();
      else {
        setDraft("");
        if (references.length > 0) onReferencesSent?.();
        setImages([]);
      }
      setBestOfOpen(false);
    } catch (cause) {
      setBestOfError(cause instanceof Error ? cause.message : "The runs could not start.");
    } finally {
      setBestOfStarting(false);
    }
  };
  const bestOfVisible = bestOf !== undefined && (bestOf.retry !== undefined || bestOfOpen);

  const addItems: MenuEntry[] = [
    {
      id: "files",
      label: "Attach files",
      icon: "paperclip",
      detail: "Or paste or drop them here",
      run: () => fileInputRef.current?.click(),
    },
    ...(capture
      ? [
          {
            id: "window",
            label: "Attach a window",
            icon: "camera" as const,
            detail: "A picture of an open window",
            run: () => setCapturing(true),
          },
        ]
      : []),
    "separator",
    {
      id: "prompts",
      label: "Saved prompts",
      icon: "bookmark",
      detail: "Or type / at the start of a message",
      run: () => {
        if (!picker.open) picker.toggle();
        textareaRef.current?.focus();
      },
    },
  ];

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

  const carriesFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    dragDepth.current = 0;
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <form
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
          Drop files to attach them
        </div>
      ) : null}
      {preview ? <ImageViewer source={preview} onClose={() => setPreview(undefined)} /> : null}
      {bestOfVisible && bestOf ? (
        <BestOfPopover
          key={bestOf.retry?.key ?? "draft"}
          agents={bestOf.agents}
          current={bestOf.current}
          retryText={bestOf.retry?.text}
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
                    <span>Pasted text</span>
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
                  </button>
                ) : (
                  <span className="composer-attachment-thumb">
                    <Icon name="image" size={16} />
                  </span>
                )}
                <RemoveAttachment name={name} onRemove={() => removeImage(image.id)} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <PromptList
        picker={picker}
        emptyHint="No saved prompts yet."
        sharedError={sharedPrompts.error}
        footer={
          <>
            {draft.trim() && slashQuery(draft) === undefined ? (
              <Button
                variant="ghost"
                size="xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  picker.close();
                  requestPromptManager({ projectId, draft });
                }}
              >
                Save draft
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                picker.close();
                requestPromptManager({ projectId });
              }}
            >
              Manage
            </Button>
          </>
        }
      />
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={onPaste}
        {...picker.inputProps}
        onKeyDown={(event) => {
          if (picker.onKeyDown(event)) return;
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
        placeholder={`Ask ${displayName} to change ${branch}`}
        aria-label={`Message ${displayName}`}
        rows={2}
      />
      <div className="composer-footer">
        <MenuButton
          label="Add files and more"
          tooltip={
            capture ? "Attach files or a window, or insert a saved prompt" : "Attach files or insert a saved prompt"
          }
          icon="plus"
          size="md"
          iconSize={16}
          align="start"
          className="composer-add"
          items={addItems}
        />
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
        <span className="composer-divider" aria-hidden="true" />
        <Picker
          label="Model"
          className={`composer-model${model ? "" : " is-default"}`}
          value={model ?? DEFAULT_MODEL}
          options={modelChoices}
          onChange={(next) => onModelChange(next || undefined)}
          disabled={modelLocked}
          tooltip={
            modelLocked
              ? `${modelLabel}. ${displayName} keeps its model for the whole session.`
              : model
                ? `${modelLabel}. Applies from your next message.`
                : `The model ${displayName} is set to use. Pick another for your next message.`
          }
        >
          <ModelMark id={model} label={modelLabel} agent={provider} size={14} />
          <span className="picker-trigger-label">{modelLabel}</span>
        </Picker>
        {reasoningLevels.length > 0 && onReasoningEffortChange ? (
          <Picker
            label="Reasoning"
            className={`composer-reasoning${reasoningEffort ? "" : " is-default"}`}
            value={reasoningEffort ?? DEFAULT_REASONING}
            options={reasoningChoices}
            onChange={(next) => onReasoningEffortChange(next || undefined)}
            tooltip={`Reasoning: ${reasoningEffort ? reasoningLabel(reasoningEffort) : "the model's own level"}. How much the model thinks before it answers.`}
            footer="Applies from your next message."
          >
            <ReasoningMeter level={reasoningEffort ?? defaultReasoning} />
            <span className="picker-trigger-label">
              {reasoningEffort
                ? reasoningLabel(reasoningEffort)
                : defaultReasoning
                  ? reasoningLabel(defaultReasoning)
                  : "Reasoning"}
            </span>
          </Picker>
        ) : null}
        {onPermissionModeChange ? (
          <Picker
            label="Permissions"
            className={`composer-permission is-${permissionMode}`}
            value={permissionMode}
            options={permissionOptions}
            onChange={onPermissionModeChange}
            tooltip={`${permissionLabel[permissionMode]}: ${permissionHint[permissionMode]} Applies from your next message.`}
            footer="Applies from your next message."
          >
            <PermissionIcon mode={permissionMode} />
            <span className="picker-trigger-label">{permissionLabel[permissionMode]}</span>
          </Picker>
        ) : (
          <span
            className={`composer-badge is-${permissionMode}`}
            data-tooltip={`${permissionLabel[permissionMode]}: ${permissionHint[permissionMode]} ${displayName} keeps this for the whole chat.`}
          >
            <PermissionIcon mode={permissionMode} />
            <span className="composer-badge-label">{permissionLabel[permissionMode]}</span>
          </span>
        )}
        <span className="composer-spacer" />
        {context ? <ContextMeter tokens={context.tokens} window={context.window} /> : null}
        {onStop ? (
          <StopButton
            size="md"
            label={`Stop ${displayName}`}
            tooltip={`Stop ${displayName}'s current turn`}
            onClick={onStop}
          />
        ) : null}
        <span className={`send-split${bestOf ? " has-menu" : ""}`} ref={sendSplitRef}>
          <button
            className="send-button"
            type="submit"
            aria-label={queues ? "Queue message" : "Send"}
            data-tooltip={queues ? `Queue. ${displayName} gets it after the current turn` : "Send"}
            data-shortcut="Enter"
            aria-keyshortcuts="Enter"
            disabled={disabled || sending || (!draft.trim() && images.length === 0 && references.length === 0)}
          >
            <Icon name="arrowUp" size={15} />
          </button>
          {bestOf ? (
            <button
              className="send-more"
              type="button"
              aria-label="More ways to send"
              aria-haspopup="menu"
              aria-expanded={sendMenuOpen}
              data-tooltip={sendMenuOpen ? undefined : "More ways to send"}
              disabled={disabled}
              onClick={() => setSendMenuOpen((open) => !open)}
            >
              <Icon name="chevronDown" size={12} />
            </button>
          ) : null}
          {sendMenuOpen ? (
            <div
              className="send-menu"
              role="menu"
              aria-label="Send options"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setSendMenuOpen(false);
              }}
            >
              <button
                className="send-menu-item"
                type="button"
                role="menuitem"
                aria-keyshortcuts={ariaShortcut(BEST_OF_SHORTCUT)}
                // biome-ignore lint/a11y/noAutofocus: the menu opens from a click and its one item takes focus.
                autoFocus
                onClick={openBestOf}
              >
                <Icon name="split" size={14} />
                <span className="send-menu-label">
                  <span>Send as Best of N</span>
                  <span className="send-menu-hint">Run this message several ways, then keep one</span>
                </span>
                <Kbd shortcut={BEST_OF_SHORTCUT} />
              </button>
            </div>
          ) : null}
        </span>
      </div>
      {error ? (
        <p className="composer-error" role="alert">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : null}
    </form>
  );
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
