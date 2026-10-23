import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { DesktopAppInfo, RuntimeEventEnvelope, RuntimeProjection } from "@zli-v2/contracts";

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const REDACTED = "[REDACTED]";
const REDACTED_URL = "[REDACTED_URL]";

export type SupportLog = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp?: string | undefined;
  context?: Record<string, unknown> | undefined;
};

export type SupportBundleInput = {
  destinationPath: string;
  allowedRoot?: string;
  projection: RuntimeProjection;
  events?: readonly RuntimeEventEnvelope[];
  logs?: readonly SupportLog[];
  /** The desktop build that asked for the bundle. */
  app?: DesktopAppInfo;
};

export class SupportBundleError extends Error {
  constructor(
    readonly code: "invalid_destination" | "already_exists" | "too_large" | "write_failed",
    message: string,
  ) {
    super(message);
    this.name = "SupportBundleError";
  }
}

export function buildSupportEntries(
  input: Pick<SupportBundleInput, "projection" | "events" | "logs" | "app">,
): Readonly<Record<string, string>> {
  const projection = input.projection;
  const runtime = {
    schemaVersion: 1,
    environment: {
      environmentId: projection.environment.environmentId,
      label: projection.environment.label,
      protocolVersion: projection.environment.protocolVersion,
      capabilities: projection.environment.capabilities,
    },
    lastSequence: projection.lastSequence,
    counts: {
      projects: projection.projects.length,
      worktrees: projection.worktrees.length,
      threads: projection.threads.length,
      terminals: projection.terminals.length,
      browserTabs: projection.browserTabs.length,
      reviews: projection.reviews?.length ?? 0,
      attention: projection.attention.length,
    },
    projects: projection.projects.map((project) => ({
      projectId: project.projectId,
      name: project.name,
    })),
    worktrees: projection.worktrees.map((worktree) => ({
      worktreeId: worktree.worktreeId,
      projectId: worktree.projectId,
      branch: worktree.branch,
      status: worktree.status,
    })),
    threads: projection.threads.map((thread) => ({
      threadId: thread.threadId,
      worktreeId: thread.worktreeId,
      provider: thread.provider,
      status: thread.status,
      capabilities: thread.capabilities,
      ...(thread.activeTurnId ? { activeTurnId: thread.activeTurnId } : {}),
    })),
    terminals: projection.terminals.map((terminal) => ({
      terminalId: terminal.terminalId,
      worktreeId: terminal.worktreeId,
      title: terminal.title,
      status: terminal.status,
      lastSequence: terminal.lastSequence,
    })),
    browserTabs: projection.browserTabs.map((tab) => ({
      browserTabId: tab.browserTabId,
      worktreeId: tab.worktreeId,
      title: tab.title,
    })),
    reviews: (projection.reviews ?? []).map((review) => ({
      worktreeId: review.worktreeId,
      baseRef: review.baseRef,
      branch: review.branch,
      state: review.state,
      files: review.files.length,
      conflicts: review.conflictFiles.length,
      updatedAt: review.updatedAt,
    })),
    attention: projection.attention.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
    })),
  };

  const logs =
    (input.logs ?? [])
      .map((log) =>
        JSON.stringify({
          level: log.level,
          ...(log.timestamp ? { timestamp: log.timestamp } : {}),
          message: redactSensitiveText(log.message),
          ...(safeLogContext(log.context) ? { context: safeLogContext(log.context) } : {}),
        }),
      )
      .join("\n") + ((input.logs ?? []).length > 0 ? "\n" : "");

  const events =
    (input.events ?? [])
      .map((event) =>
        JSON.stringify({
          sequence: event.sequence,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          type: event.event.type,
        }),
      )
      .join("\n") + ((input.events ?? []).length > 0 ? "\n" : "");

  return {
    "manifest.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        ...(input.app ? { app: safeAppInfo(input.app) } : {}),
        entries: ["runtime.json", "logs.jsonl", "events.jsonl"],
        redaction: "allowlist-v1",
        note: "Runtime identifiers and operational metadata only; paths, URLs, prompts, cookies, credentials, and file contents are excluded.",
      },
      null,
      2,
    )}\n`,
    "runtime.json": `${JSON.stringify(runtime, null, 2)}\n`,
    "logs.jsonl": logs,
    "events.jsonl": events,
  };
}

export async function createSupportBundle(
  input: SupportBundleInput,
): Promise<{ path: string; bytes: number; entries: string[] }> {
  const destinationPath = resolveSupportBundleDestination(input.destinationPath, input.allowedRoot ?? tmpdir());
  if (extname(destinationPath).toLowerCase() !== ".zip") {
    throw new SupportBundleError("invalid_destination", "Support bundles must use a .zip destination.");
  }

  const entries = buildSupportEntries(input);
  const archive = createZip(entries);
  if (archive.byteLength > MAX_BUNDLE_BYTES) {
    throw new SupportBundleError("too_large", "Support bundle exceeds the 5 MiB safety limit.");
  }

  try {
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, archive, { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new SupportBundleError("already_exists", "Support bundle destination already exists.");
    }
    throw new SupportBundleError("write_failed", "Unable to write support bundle.");
  }

  return { path: destinationPath, bytes: archive.byteLength, entries: Object.keys(entries) };
}

const DESTINATION_OUTSIDE = "Support bundle destination must stay inside the export directory.";

function resolveSupportBundleDestination(destinationPath: string, allowedRoot: string): string {
  if (
    destinationPath.length === 0 ||
    allowedRoot.length === 0 ||
    destinationPath.includes("\0") ||
    allowedRoot.includes("\0")
  ) {
    throw new SupportBundleError("invalid_destination", DESTINATION_OUTSIDE);
  }
  const root = resolve(allowedRoot);
  const target = resolve(root, destinationPath);
  if (!isInsideDirectory(root, target)) {
    throw new SupportBundleError("invalid_destination", DESTINATION_OUTSIDE);
  }
  return target;
}

function isInsideDirectory(root: string, target: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const child = relative(fold(root), fold(target));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function safeAppInfo(app: DesktopAppInfo): DesktopAppInfo {
  return {
    version: redactSensitiveText(app.version),
    platform: redactSensitiveText(app.platform),
    arch: redactSensitiveText(app.arch),
    ...(app.electron ? { electron: redactSensitiveText(app.electron) } : {}),
    ...(app.packaged === undefined ? {} : { packaged: app.packaged }),
  };
}

function safeLogContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const allowedKeys = new Set([
    "component",
    "operation",
    "code",
    "retryable",
    "durationMs",
    "status",
    "commandId",
    "workspaceId",
    "threadId",
    "terminalId",
    "browserTabId",
    "worktreeId",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === "string") result[key] = redactSensitiveText(value);
    if (typeof value === "boolean" || typeof value === "number") result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/giu, REDACTED_URL)
    .replace(/(cookie|set-cookie|authorization)\s*:\s*[^\r\n]+/giu, `$1: ${REDACTED}`)
    .replace(/(bearer\s+)[^\s"']+/giu, `$1${REDACTED}`)
    .replace(
      /(["']?(?:password|passwd|secret|token|cookie|authorization|api[_-]?key|access[_-]?token|prompt|input|content)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\r\n}]*)/giu,
      `$1${REDACTED}`,
    )
    .replace(/(?:[a-z]:\\|\\\\)[^\s"']+/giu, REDACTED)
    .replace(/(?:^|\s)\/(?:Users|home|tmp|var|private|workspace)\/[^\s"']+/giu, ` ${REDACTED}`);
}

function createZip(entries: Readonly<Record<string, string>>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name, "utf8");
    const data = Buffer.from(value, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    filename.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(localData.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localData, centralData, end]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
