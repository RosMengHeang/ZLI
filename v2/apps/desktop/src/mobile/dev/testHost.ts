import { DEFAULT_MOBILE_SETTINGS, type MobileSettings, RpcResponse } from "@zli-v2/contracts";

import type { BrowserControlWorktree } from "../../browser/BrowserControlActions.js";
import type { DeviceManager } from "../DeviceManager.js";
import type { FetchLike } from "../download.js";
import { FakeProcessRunner } from "../FakeProcessRunner.js";
import type { HostOs, MobileFileSystem } from "../host.js";
import type { MobileDevHost } from "./host.js";
import { type ProposalFiles, ProposalStore } from "./ProposalStore.js";

export type RecordedCommand = { protocolVersion: 1; commandId: string; command: Record<string, unknown> };

/** A MobileDevHost for unit tests, with every outside effect recorded or scripted. */
export type TestDevHost = MobileDevHost & {
  readonly runner: FakeProcessRunner;
  /** File contents by absolute path. Feature reads and proposal writes both use it. */
  readonly files: Map<string, string>;
  /** Runtime commands, such as terminal.create from an accepted proposal. */
  readonly commands: RecordedCommand[];
  readonly sent: { channel: string; payload: unknown }[];
  settingsValue: MobileSettings;
};

export function createTestDevHost(
  options: {
    worktrees?: BrowserControlWorktree[];
    files?: Record<string, string>;
    os?: HostOs;
    runner?: FakeProcessRunner;
    fetch?: FetchLike;
    manager?: DeviceManager;
    /** What the runtime answers, without the commandId, such as { accepted: false, error }. Accepted by default. */
    answer?: (command: RecordedCommand) => Record<string, unknown>;
    now?: Date;
  } = {},
): TestDevHost {
  const worktrees = options.worktrees ?? [{ worktreeId: "wt-1", path: "/repo/app", status: "ready" }];
  const files = new Map(Object.entries(options.files ?? {}));
  const commands: RecordedCommand[] = [];
  const sent: { channel: string; payload: unknown }[] = [];
  const os = options.os ?? "linux";
  const separator = os === "windows" ? "\\" : "/";
  const under = (path: string) => (path.endsWith(separator) ? path : `${path}${separator}`);
  const fs: MobileFileSystem = {
    exists: async (path) => files.has(path) || [...files.keys()].some((key) => key.startsWith(under(path))),
    isDirectory: async (path) => [...files.keys()].some((key) => key.startsWith(under(path))),
    readdir: async (path) => [
      ...new Set(
        [...files.keys()]
          .filter((key) => key.startsWith(under(path)))
          .map((key) => key.slice(under(path).length).split(separator)[0] ?? ""),
      ),
    ],
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
  };
  const proposalFiles: ProposalFiles = {
    read: async (path) => files.get(path),
    isLink: async () => false,
    writeAtomic: async (path, text) => {
      files.set(path, text);
    },
  };
  const now = options.now ?? new Date("2026-01-02T03:04:05.000Z");
  let id = 0;
  const host: TestDevHost = {
    runner: options.runner ?? new FakeProcessRunner(),
    fs,
    fetch:
      options.fetch ??
      (async () => ({ ok: false, status: 404, body: null, headers: { get: () => null }, text: async () => "" })),
    os,
    env: { PATH: "/usr/bin" },
    home: "/home/person",
    worktrees: () => worktrees,
    worktreePath: (worktreeId) => worktrees.find((entry) => entry.worktreeId === worktreeId)?.path,
    manager: () => options.manager,
    settings: async () => host.settingsValue,
    settingsValue: { ...DEFAULT_MOBILE_SETTINGS },
    proposals: new ProposalStore({
      worktrees: () => worktrees,
      command: async (request) => {
        commands.push(request);
        return RpcResponse.parse({ accepted: true, ...options.answer?.(request), commandId: request.commandId });
      },
      onChange: (list) => sent.push({ channel: "zli:mobile:proposals", payload: list }),
      platform: os === "windows" ? "win32" : os === "macos" ? "darwin" : "linux",
      files: proposalFiles,
      // UUIDs, because proposal and terminal ids are parsed as UUIDs.
      newId: () => {
        id += 1;
        return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
      },
      now: () => now,
    }),
    send: (channel, payload) => sent.push({ channel, payload }),
    now: () => now,
    files,
    commands,
    sent,
  };
  return host;
}
