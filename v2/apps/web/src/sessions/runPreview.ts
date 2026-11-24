import type { DevServerProjection, RpcResponse, TerminalProjection } from "@zli-v2/contracts";

import { readFile } from "../files/fileClient.js";
import { actionTerminalCommand } from "../plugins/plugins.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

const STORAGE_PREFIX = "zli.previewCommand.";
const SCRIPT_ORDER = ["dev", "start", "serve", "preview"] as const;
const LOCKFILES: readonly [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
];

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The command the person chose for previewing this project's runs, if they chose one. */
export function savedPreviewCommand(projectId: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(STORAGE_PREFIX + projectId)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function savePreviewCommand(projectId: string, command: string): void {
  try {
    const value = command.trim();
    if (value) globalThis.localStorage?.setItem(STORAGE_PREFIX + projectId, value);
    else globalThis.localStorage?.removeItem(STORAGE_PREFIX + projectId);
  } catch {
    // Storage can be blocked; the person is asked again next time.
  }
}

/**
 * The dev command a package.json names, as `<manager> install && <manager> run <script>`. A fresh worktree has no
 * installed packages, so the install comes first. Nothing when there is no package.json or no dev-like script.
 */
export function devCommandFromPackage(text: string, manager: PackageManager = "npm"): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return undefined;
  const script = SCRIPT_ORDER.find((name) => typeof (scripts as Record<string, unknown>)[name] === "string");
  if (!script) return undefined;
  const named = (parsed as { packageManager?: unknown }).packageManager;
  const fromField = typeof named === "string" ? (named.split("@")[0] as PackageManager) : undefined;
  const pm = fromField && ["npm", "pnpm", "yarn", "bun"].includes(fromField) ? fromField : manager;
  return `${pm} install && ${pm} run ${script}`;
}

/** Reads the worktree's package.json and lockfiles to guess the dev command. */
export async function detectDevCommand(dispatch: Dispatch, worktreeId: string): Promise<string | undefined> {
  let text: string | undefined;
  try {
    text = (await readFile(dispatch, worktreeId, "package.json")).content;
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  let manager: PackageManager = "npm";
  for (const [file, name] of LOCKFILES) {
    try {
      await readFile(dispatch, worktreeId, file);
      manager = name;
      break;
    } catch {
      // Not there; try the next one.
    }
  }
  return devCommandFromPackage(text, manager);
}

/** The terminal that runs the preview command in the run's worktree, titled after the run. */
export function previewTerminalCommand(
  command: string,
  worktree: { worktreeId: string; path: string },
  title: string,
  windows?: boolean,
) {
  return actionTerminalCommand({ name: title, command }, worktree, windows);
}

export type PreviewState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready"; url: string }
  | { kind: "failed"; message: string };

/**
 * Where a run's preview stands: a dev server seen in its worktree is ready, whichever terminal started it. The
 * terminal ZLI started is starting until its server prints an address, and failed when it exits first.
 */
export function previewState(
  devServers: readonly DevServerProjection[] | undefined,
  terminals: readonly TerminalProjection[],
  worktreeId: string | undefined,
  terminalId: string | undefined,
): PreviewState {
  if (!worktreeId) return { kind: "idle" };
  const servers = (devServers ?? []).filter((server) => server.worktreeId === worktreeId);
  const own = terminalId ? servers.filter((server) => server.terminalId === terminalId).at(-1) : undefined;
  const any = own ?? servers.at(-1);
  if (any) return { kind: "ready", url: any.url };
  if (!terminalId) return { kind: "idle" };
  const terminal = terminals.find((entry) => entry.terminalId === terminalId);
  if (terminal && (terminal.status === "exited" || terminal.status === "failed")) {
    return {
      kind: "failed",
      message: terminal.errorMessage ?? "The preview command stopped before it printed an address.",
    };
  }
  return { kind: "starting" };
}
