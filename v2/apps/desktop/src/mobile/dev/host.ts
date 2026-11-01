import type { MobileControlAction, MobileSettings } from "@zli-v2/contracts";

import type { BrowserControlWorktree } from "../../browser/BrowserControlActions.js";
import type { LeaseOwner } from "../DeviceLeases.js";
import type { DeviceManager } from "../DeviceManager.js";
import type { FetchLike } from "../download.js";
import type { HostOs, MobileFileSystem } from "../host.js";
import type { MobileDevAction } from "../MobileControlActions.js";
import type { MobileIpcHandler } from "../mobileIpc.js";
import type { ProcessRunner } from "../ProcessRunner.js";
import type { ProposalStore } from "./ProposalStore.js";

/** What every mobile dev feature gets from the desktop. Features never reach Electron or process.env directly. */
export type MobileDevHost = {
  /** Every process a feature starts goes through this, so tests and the e2e fake can script it. */
  readonly runner: ProcessRunner;
  readonly fs: MobileFileSystem;
  readonly fetch: FetchLike;
  readonly os: HostOs;
  /** The desktop's environment without ZLI's private variables. Pass it to every process a feature starts. */
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  worktrees(): readonly BrowserControlWorktree[];
  /** The folder of a worktree ZLI knows, or undefined. */
  worktreePath(worktreeId: string): string | undefined;
  manager(): DeviceManager | undefined;
  settings(): Promise<MobileSettings>;
  /** Commands and file writes a feature generates go here, so they run only after the person confirms them. */
  readonly proposals: ProposalStore;
  /** Sends an event to the main window and the device pop-outs. */
  send(channel: string, payload: unknown): void;
  now(): Date;
};

export type MobileDevDecorate = (owner: LeaseOwner, action: MobileControlAction, result: unknown) => unknown;

/** An operation the e2e tests call through zli:test:mobile. */
export type MobileDevTestOp = (input: unknown) => unknown;

/** One feature's share of the agent actions, the renderer's IPC channels, and the e2e test operations. */
export type MobileDevFeature = {
  readonly actions: Partial<Record<MobileControlAction, MobileDevAction>>;
  /** Channels are named zli:mobile:<feature>:<verb>. */
  readonly ipc: Record<string, MobileIpcHandler>;
  /** Can add a field to the result of any agent action, such as a notice about a crash. */
  readonly decorate: MobileDevDecorate | undefined;
  readonly testOps: Record<string, MobileDevTestOp>;
  dispose(): void | Promise<void>;
};

export function emptyMobileDevFeature(): MobileDevFeature {
  return { actions: {}, ipc: {}, decorate: undefined, testOps: {}, dispose() {} };
}
