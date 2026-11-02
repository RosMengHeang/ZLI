import type { MetroOwner } from "@zli-v2/contracts";

import { type MobileFileSystem, pathFor } from "../../host.js";
import type { ProcessRunner, RunResult } from "../../ProcessRunner.js";
import type { MobileDevHost } from "../host.js";

/** A worktree the owner check can match a listener's folder against. realPath is path with symlinks resolved. */
export type OwnerWorktree = {
  readonly worktreeId: string;
  readonly path: string;
  readonly branch: string;
  readonly realPath?: string | undefined;
};

export type PortOwnerHost = Pick<MobileDevHost, "runner" | "os" | "env"> & {
  readonly fs?: Pick<MobileFileSystem, "realpath"> | undefined;
};

const TIMEOUT_MS = 3_000;

/**
 * Who listens on `port`: this worktree, another worktree (matched by the listener's working folder), another
 * program, or nobody. Read-only: it only lists listeners and reads a process's folder.
 */
export async function metroOwner(
  port: number,
  selfWorktreeId: string,
  worktrees: readonly OwnerWorktree[],
  host: PortOwnerHost,
): Promise<MetroOwner> {
  if (host.os === "windows") return { state: "unknown", reason: "Port owners are not checked on Windows yet." };
  const listener = await findListener(port, host);
  if (listener.state !== "found") return listener.owner;
  const { pid } = listener;
  if (pid === undefined) return { state: "other-process" };
  const cwd = await processFolder(pid, host);
  if (!cwd) return { state: "unknown", reason: `ZLI could not read the folder of process ${pid}.` };
  const worktree = owningWorktree(cwd, await resolveRoots(worktrees, host), host.os);
  if (!worktree) return { state: "other-process", pid };
  if (worktree.worktreeId === selfWorktreeId) return { state: "this-worktree", pid };
  return { state: "other-worktree", pid, worktreeId: worktree.worktreeId, branch: worktree.branch };
}

type Listener = { state: "found"; pid: number | undefined } | { state: "done"; owner: MetroOwner };

async function findListener(port: number, host: PortOwnerHost): Promise<Listener> {
  const lsof = await run(host, "lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
  if (lsof.kind === "timeout")
    return { state: "done", owner: { state: "unknown", reason: "The port check took too long." } };
  if (lsof.kind === "ran") {
    const pid = firstField(lsof.result.stdout.toString("utf8"), "p");
    // lsof exits 1 when nothing matches.
    if (pid !== undefined) return { state: "found", pid: Number(pid) };
    if (lsof.result.code === 0 || lsof.result.code === 1) {
      if (host.os !== "linux") return { state: "done", owner: { state: "free" } };
      // lsof cannot see other users' sockets, such as docker-proxy, so ss confirms before a port is called free.
      return ssListener(
        port,
        host,
        "lsof found no listener, and ss is not available to confirm, so the port was not checked.",
      );
    }
  }
  if (host.os !== "linux")
    return {
      state: "done",
      owner: { state: "unknown", reason: "lsof is not available, so the port was not checked." },
    };
  return ssListener(port, host, "Neither lsof nor ss is available, so the port was not checked.");
}

async function ssListener(port: number, host: PortOwnerHost, unavailable: string): Promise<Listener> {
  const ss = await run(host, "ss", ["-ltnpH", `sport = :${port}`]);
  if (ss.kind === "timeout")
    return { state: "done", owner: { state: "unknown", reason: "The port check took too long." } };
  if (ss.kind === "missing" || ss.result.code !== 0)
    return { state: "done", owner: { state: "unknown", reason: unavailable } };
  const lines = ss.result.stdout
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim());
  if (lines.length === 0) return { state: "done", owner: { state: "free" } };
  // ss shows the pid only for the person's own processes.
  const pid = /pid=(\d+)/u.exec(lines[0] ?? "")?.[1];
  return { state: "found", pid: pid ? Number(pid) : undefined };
}

async function processFolder(pid: number, host: PortOwnerHost): Promise<string | undefined> {
  const lsof = await run(host, "lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (lsof.kind === "ran" && lsof.result.code === 0) {
    const folder = firstField(lsof.result.stdout.toString("utf8"), "n");
    if (folder) return folder;
  }
  if (host.os !== "linux") return undefined;
  const link = await run(host, "readlink", [`/proc/${pid}/cwd`]);
  if (link.kind !== "ran" || link.result.code !== 0) return undefined;
  return link.result.stdout.toString("utf8").trim() || undefined;
}

/**
 * lsof and /proc report resolved folders, while a worktree path can go through a symlink, so each worktree
 * also carries its real path. Without realpath the unresolved path is all there is.
 */
async function resolveRoots(
  worktrees: readonly OwnerWorktree[],
  host: PortOwnerHost,
): Promise<readonly OwnerWorktree[]> {
  if (!host.fs?.realpath) return worktrees;
  return Promise.all(
    worktrees.map(async (worktree) => {
      const real = await host.fs?.realpath?.(worktree.path).catch(() => undefined);
      return real && real !== worktree.path ? { ...worktree, realPath: real } : worktree;
    }),
  );
}

/** The worktree whose folder holds `folder`. The deepest wins, since worktrees can sit inside the checkout. */
export function owningWorktree(
  folder: string,
  worktrees: readonly OwnerWorktree[],
  os: PortOwnerHost["os"],
): OwnerWorktree | undefined {
  const path = pathFor(os);
  const target = trimSeparator(path.normalize(folder), path.sep);
  let best: OwnerWorktree | undefined;
  let bestLength = -1;
  for (const worktree of worktrees) {
    const roots = worktree.realPath
      ? [...rootsOf(worktree.path, os), ...rootsOf(worktree.realPath, os)]
      : rootsOf(worktree.path, os);
    for (const root of roots) {
      const normalized = trimSeparator(path.normalize(root), path.sep);
      if (target !== normalized && !target.startsWith(`${normalized}${path.sep}`)) continue;
      if (normalized.length > bestLength) {
        best = worktree;
        bestLength = normalized.length;
      }
    }
  }
  return best;
}

/** lsof reports resolved folders, and on macOS /tmp and /var resolve under /private. */
function rootsOf(root: string, os: PortOwnerHost["os"]): string[] {
  if (os === "macos" && /^\/(tmp|var|etc)(\/|$)/u.test(root)) return [root, `/private${root}`];
  return [root];
}

function trimSeparator(value: string, separator: string): string {
  return value.length > 1 && value.endsWith(separator) ? value.slice(0, -1) : value;
}

/** The value of the first `-F` field line with this tag, such as p1234 or n/Users/me/app. */
function firstField(output: string, tag: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(tag)) continue;
    const value = line.slice(1).trim();
    if (!value) continue;
    if (tag === "p") return /^\d+$/u.test(value) ? value : undefined;
    return value;
  }
  return undefined;
}

type Ran = { kind: "ran"; result: RunResult } | { kind: "missing" } | { kind: "timeout" };

async function run(
  host: { runner: ProcessRunner; env: NodeJS.ProcessEnv },
  command: string,
  args: string[],
): Promise<Ran> {
  try {
    const result = await host.runner.run(command, args, {
      env: host.env,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    return result.timedOut ? { kind: "timeout" } : { kind: "ran", result };
  } catch {
    return { kind: "missing" };
  }
}
