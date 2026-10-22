import { z } from "zod";

import { TerminalId, WorktreeId } from "./ids.js";
import type { RuntimeProjection } from "./projections.js";

/** Hosts a dev server prints for itself. Wildcard binds are opened as localhost. */
const LOOPBACK_HOSTS: Record<string, string> = {
  localhost: "localhost",
  "127.0.0.1": "127.0.0.1",
  "[::1]": "[::1]",
  "0.0.0.0": "localhost",
  "[::]": "localhost",
};

const MAX_PER_TERMINAL = 4;
const MAX_DEV_SERVERS = 64;

/**
 * Reads a URL a dev server printed and returns it in the form the browser should open, or nothing
 * when it is not an http(s) address on this machine with an explicit port.
 */
export function parseDevServerUrl(raw: string): { url: string; port: number } | undefined {
  if (raw.length > 2_000) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  const host = LOOPBACK_HOSTS[parsed.hostname.toLowerCase()];
  const port = Number(parsed.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { url: `${parsed.protocol}//${host}:${port}${parsed.pathname}`, port };
}

export const DevServerProjection = z.object({
  worktreeId: WorktreeId,
  terminalId: TerminalId,
  url: z
    .string()
    .min(1)
    .max(2_000)
    .refine((value) => parseDevServerUrl(value)?.url === value, "Dev server URLs must be local http(s) addresses."),
  port: z.number().int().min(1).max(65_535),
  detectedAt: z.string().datetime({ offset: true }),
});
export type DevServerProjection = z.infer<typeof DevServerProjection>;

/** A server that prints again on the same port replaces its earlier record. */
export function upsertDevServer(
  devServers: readonly DevServerProjection[],
  devServer: DevServerProjection,
): DevServerProjection[] {
  const next = [
    ...devServers.filter(
      (candidate) => !(candidate.terminalId === devServer.terminalId && candidate.port === devServer.port),
    ),
    devServer,
  ];
  const sameTerminal = next.filter((candidate) => candidate.terminalId === devServer.terminalId);
  const dropped = new Set(sameTerminal.slice(0, Math.max(0, sameTerminal.length - MAX_PER_TERMINAL)));
  return next.filter((candidate) => !dropped.has(candidate)).slice(-MAX_DEV_SERVERS);
}

export function removeDevServer(
  devServers: readonly DevServerProjection[],
  terminalId: string,
  port: number,
): DevServerProjection[] {
  return devServers.filter((candidate) => !(candidate.terminalId === terminalId && candidate.port === port));
}

/**
 * Drops servers whose terminal has exited or is gone, or whose worktree was removed. Returns the
 * same array when nothing changed so unchanged projections keep their identity.
 */
export function pruneDevServers(
  state: Pick<RuntimeProjection, "devServers" | "terminals" | "worktrees">,
): DevServerProjection[] | undefined {
  const devServers = state.devServers;
  if (!devServers || devServers.length === 0) return devServers;
  const liveTerminals = new Set(
    state.terminals
      .filter((terminal) => terminal.status === "starting" || terminal.status === "running")
      .map((terminal) => terminal.terminalId as string),
  );
  const worktrees = new Set(state.worktrees.map((worktree) => worktree.worktreeId as string));
  const kept = devServers.filter(
    (devServer) => liveTerminals.has(devServer.terminalId) && worktrees.has(devServer.worktreeId),
  );
  return kept.length === devServers.length ? devServers : kept;
}

/** Newest first, for one worktree. */
export function worktreeDevServers(
  devServers: readonly DevServerProjection[] | undefined,
  worktreeId: string | undefined,
): DevServerProjection[] {
  if (!devServers || !worktreeId) return [];
  return devServers.filter((devServer) => devServer.worktreeId === worktreeId).reverse();
}
