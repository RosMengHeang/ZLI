import { CONTROL_PROTOCOL_VERSION } from "../../control/protocol.ts";

export const BROWSER_PROTOCOL_VERSION = CONTROL_PROTOCOL_VERSION;

export type BrowserCapability =
  | "browser.read"
  | "browser.control"
  | "browser.javascript"
  | "browser.storage"
  | "browser.download";

export interface BrowserSurfaceRecord {
  surfaceId: string;
  projectId: string;
  agentId: string | null;
  url: string;
  profileId: string;
  capabilities: BrowserCapability[];
  createdAt: string;
}

export interface BrowserControlStatus {
  profileId: string;
  enabled: boolean;
  surfaceCount: number;
}

export interface BrowserRuntimeStatus extends BrowserControlStatus {
  bridgeAvailable: boolean;
}

export const BROWSER_LIMITS = Object.freeze({
  maxSnapshotCharacters: 100_000,
  maxScriptCharacters: 20_000,
  maxSnapshotDepth: 32,
  maxSelectorCharacters: 4_096,
  maxFillCharacters: 100_000,
  maxConsoleEntries: 500,
  maxPageErrors: 200,
  maxScreenshotCharacters: 4_186_112,
  minCommandTimeoutMs: 100,
  maxCommandTimeoutMs: 120_000,
});

const BROWSER_KEYS = [
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
] as const;

export type BrowserKey = (typeof BROWSER_KEYS)[number];
export type SelectorState = "attached" | "visible" | "hidden" | "detached";
export type LoadState = "domContentLoaded" | "load" | "networkIdle";

export type BrowserWaitCondition =
  | { kind: "selector"; selector: string; state?: SelectorState }
  | { kind: "url"; url: string }
  | { kind: "load"; state: LoadState };

export type BrowserCommand =
  | { kind: "open"; url: string }
  | { kind: "navigate"; surfaceId: string; url: string }
  | { kind: "wait"; surfaceId: string; condition: BrowserWaitCondition; timeoutMs: number }
  | { kind: "snapshot"; surfaceId: string; selector?: string; maxDepth?: number }
  | { kind: "click"; surfaceId: string; selector: string }
  | { kind: "fill"; surfaceId: string; selector: string; text: string }
  | { kind: "press"; surfaceId: string; key: BrowserKey }
  | { kind: "eval"; surfaceId: string; script: string }
  | { kind: "console"; surfaceId: string }
  | { kind: "errors"; surfaceId: string }
  | { kind: "screenshot"; surfaceId: string };

export interface BrowserConsoleEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
}

export interface BrowserPageError {
  message: string;
  source?: string;
  line?: number;
  column?: number;
}

export type BrowserResult =
  | { kind: "surface"; surfaceId: string; projectId: string; agentId: string | null; url: string; profileId: string }
  | { kind: "navigation"; surfaceId: string; url: string; phase: "started" | "finished" }
  | { kind: "action"; surfaceId: string; action: "wait" | "click" | "fill" | "press" }
  | { kind: "evaluation"; surfaceId: string; value: unknown; truncated: boolean }
  | { kind: "snapshot"; surfaceId: string; content: string; truncated: boolean }
  | { kind: "consoleEntries"; surfaceId: string; entries: BrowserConsoleEntry[]; truncated: boolean }
  | { kind: "pageErrors"; surfaceId: string; errors: BrowserPageError[]; truncated: boolean }
  | { kind: "screenshot"; surfaceId: string; dataUrl: string; width: number; height: number };

export class BrowserProtocolError extends Error {
  readonly code = "BROWSER_INVALID_COMMAND" as const;

  constructor(message: string) {
    super(message);
    this.name = "BrowserProtocolError";
  }
}

function invalid(message: string): never {
  throw new BrowserProtocolError(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, field: string, maxCharacters?: number): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a nonempty string`);
  if (maxCharacters !== undefined && [...value].length > maxCharacters) {
    invalid(`${field} exceeds ${maxCharacters} characters`);
  }
  return value;
}

function boundedText(value: unknown, field: string, maxCharacters: number): string {
  if (typeof value !== "string") invalid(`${field} must be a string`);
  if ([...value].length > maxCharacters) invalid(`${field} exceeds ${maxCharacters} characters`);
  return value;
}

function surfaceId(value: unknown): string {
  return text(value, "surfaceId");
}

function selector(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  return text(value, "selector", BROWSER_LIMITS.maxSelectorCharacters);
}

function safeUrl(value: unknown): string {
  const raw = text(value, "url");
  if (raw === "about:blank") return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid("url must be an absolute http or https URL, or about:blank");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
  ) {
    invalid("url must use http, https, or about:blank");
  }
  return raw;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function decodeWaitCondition(value: unknown): BrowserWaitCondition {
  const condition = record(value);
  if (!condition || typeof condition.kind !== "string") invalid("condition must be a browser wait condition");
  if (condition.kind === "selector") {
    const state = condition.state;
    if (state !== undefined && !["attached", "visible", "hidden", "detached"].includes(String(state))) {
      invalid("condition.state is not supported");
    }
    return {
      kind: "selector",
      selector: selector(condition.selector, true)!,
      ...(state === undefined ? {} : { state: state as SelectorState }),
    };
  }
  if (condition.kind === "url") return { kind: "url", url: safeUrl(condition.url) };
  if (condition.kind === "load") {
    if (!["domContentLoaded", "load", "networkIdle"].includes(String(condition.state))) {
      invalid("condition.state is not supported");
    }
    return { kind: "load", state: condition.state as LoadState };
  }
  return invalid("condition.kind is not supported");
}

export function decodeBrowserCommand(value: unknown): BrowserCommand {
  const command = record(value);
  if (!command || typeof command.kind !== "string") invalid("kind must identify a browser command");
  switch (command.kind) {
    case "open":
      return { kind: "open", url: safeUrl(command.url) };
    case "navigate":
      return { kind: "navigate", surfaceId: surfaceId(command.surfaceId), url: safeUrl(command.url) };
    case "wait":
      return {
        kind: "wait",
        surfaceId: surfaceId(command.surfaceId),
        condition: decodeWaitCondition(command.condition),
        timeoutMs: boundedInteger(
          command.timeoutMs,
          "timeoutMs",
          BROWSER_LIMITS.minCommandTimeoutMs,
          BROWSER_LIMITS.maxCommandTimeoutMs,
        ),
      };
    case "snapshot": {
      const maxDepth = command.maxDepth === undefined
        ? undefined
        : boundedInteger(command.maxDepth, "maxDepth", 1, BROWSER_LIMITS.maxSnapshotDepth);
      const targetSelector = selector(command.selector, false);
      return {
        kind: "snapshot",
        surfaceId: surfaceId(command.surfaceId),
        ...(targetSelector === undefined ? {} : { selector: targetSelector }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
      } as BrowserCommand;
    }
    case "click":
      return { kind: "click", surfaceId: surfaceId(command.surfaceId), selector: selector(command.selector, true)! };
    case "fill":
      return {
        kind: "fill",
        surfaceId: surfaceId(command.surfaceId),
        selector: selector(command.selector, true)!,
        text: typeof command.text === "string" && [...command.text].length <= BROWSER_LIMITS.maxFillCharacters
          ? command.text
          : invalid(`text must not exceed ${BROWSER_LIMITS.maxFillCharacters} characters`),
      };
    case "press": {
      const key = text(command.key, "key");
      if (!(BROWSER_KEYS as readonly string[]).includes(key)) invalid("key is not supported");
      return { kind: "press", surfaceId: surfaceId(command.surfaceId), key: key as BrowserKey };
    }
    case "eval":
      return {
        kind: "eval",
        surfaceId: surfaceId(command.surfaceId),
        script: text(command.script, "script", BROWSER_LIMITS.maxScriptCharacters),
      };
    case "console":
    case "errors":
    case "screenshot":
      return { kind: command.kind, surfaceId: surfaceId(command.surfaceId) };
    default:
      return invalid("kind is not supported");
  }
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`${field} must be a boolean`);
  return value;
}

function nullableId(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

function consoleEntry(value: unknown): BrowserConsoleEntry {
  const entry = record(value);
  if (!entry || !["debug", "info", "warn", "error"].includes(String(entry.level))) invalid("console entry is invalid");
  return {
    level: entry.level as BrowserConsoleEntry["level"],
    message: typeof entry.message === "string" ? entry.message : invalid("console entry is invalid"),
    timestamp: text(entry.timestamp, "console entry timestamp"),
  };
}

function pageError(value: unknown): BrowserPageError {
  const error = record(value);
  if (!error || typeof error.message !== "string") invalid("page error is invalid");
  for (const field of ["line", "column"] as const) {
    if (error[field] !== undefined && (typeof error[field] !== "number" || !Number.isSafeInteger(error[field]) || error[field] < 0)) {
      invalid(`page error ${field} is invalid`);
    }
  }
  if (error.source !== undefined && typeof error.source !== "string") invalid("page error source is invalid");
  return {
    message: error.message,
    ...(error.source === undefined ? {} : { source: error.source }),
    ...(error.line === undefined ? {} : { line: error.line as number }),
    ...(error.column === undefined ? {} : { column: error.column as number }),
  };
}

export function decodeBrowserResult(value: unknown): BrowserResult {
  const result = record(value);
  if (!result || typeof result.kind !== "string") invalid("Browser result is invalid");
  const id = surfaceId(result.surfaceId);
  switch (result.kind) {
    case "surface":
      return {
        kind: "surface",
        surfaceId: id,
        projectId: text(result.projectId, "projectId"),
        agentId: nullableId(result.agentId, "agentId"),
        url: safeUrl(result.url),
        profileId: text(result.profileId, "profileId"),
      };
    case "navigation":
      if (result.phase !== "started" && result.phase !== "finished") invalid("phase is invalid");
      return { kind: "navigation", surfaceId: id, url: safeUrl(result.url), phase: result.phase };
    case "action":
      if (!["wait", "click", "fill", "press"].includes(String(result.action))) invalid("action is invalid");
      return { kind: "action", surfaceId: id, action: result.action as "wait" | "click" | "fill" | "press" };
    case "evaluation":
      return {
        kind: "evaluation",
        surfaceId: id,
        value: result.value,
        truncated: boolean(result.truncated, "truncated"),
      };
    case "snapshot":
      return {
        kind: "snapshot",
        surfaceId: id,
        content: boundedText(result.content, "content", BROWSER_LIMITS.maxSnapshotCharacters),
        truncated: boolean(result.truncated, "truncated"),
      };
    case "consoleEntries": {
      if (!Array.isArray(result.entries) || result.entries.length > BROWSER_LIMITS.maxConsoleEntries) invalid("entries are invalid");
      return { kind: "consoleEntries", surfaceId: id, entries: result.entries.map(consoleEntry), truncated: boolean(result.truncated, "truncated") };
    }
    case "pageErrors": {
      if (!Array.isArray(result.errors) || result.errors.length > BROWSER_LIMITS.maxPageErrors) invalid("errors are invalid");
      return { kind: "pageErrors", surfaceId: id, errors: result.errors.map(pageError), truncated: boolean(result.truncated, "truncated") };
    }
    case "screenshot":
      if (typeof result.dataUrl !== "string" || !result.dataUrl.startsWith("data:image/png;base64,")) {
        invalid("dataUrl must contain a PNG screenshot");
      }
      return {
        kind: "screenshot",
        surfaceId: id,
        dataUrl: text(result.dataUrl, "dataUrl", BROWSER_LIMITS.maxScreenshotCharacters),
        width: boundedInteger(result.width, "width", 1, 100_000),
        height: boundedInteger(result.height, "height", 1, 100_000),
      };
    default:
      return invalid("Browser result kind is not supported");
  }
}
