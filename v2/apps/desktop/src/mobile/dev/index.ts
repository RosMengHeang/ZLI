import type { MobileControlAction } from "@zli-v2/contracts";

import type { LeaseOwner } from "../DeviceLeases.js";
import type { MobileDevAction } from "../MobileControlActions.js";
import type { MobileIpcHandler } from "../mobileIpc.js";
import { createBuild } from "./build/index.js";
import { createConditions } from "./conditions/index.js";
import { createCrash } from "./crash/index.js";
import { createDoctor } from "./doctor/index.js";
import type { MobileDevDecorate, MobileDevFeature, MobileDevHost, MobileDevTestOp } from "./host.js";
import { createPackages } from "./packages/index.js";
import { createProposalFeature } from "./proposalActions.js";
import { createWorkspace } from "./workspace/index.js";

/** Every mobile dev feature, joined into what the agent actions, the IPC handlers, and the e2e hook take. */
export type MobileDev = {
  readonly actions: Partial<Record<MobileControlAction, MobileDevAction>>;
  readonly ipc: Record<string, MobileIpcHandler>;
  readonly testOps: Record<string, MobileDevTestOp>;
  decorate?(owner: LeaseOwner, action: MobileControlAction, result: unknown): unknown;
  dispose(): Promise<void>;
};

export function createMobileDev(host: MobileDevHost): MobileDev {
  return composeMobileDev([
    createProposalFeature(host),
    createWorkspace(host),
    createDoctor(host),
    createPackages(host),
    createCrash(host),
    createBuild(host),
    createConditions(host),
  ]);
}

/** Two features claiming the same action, channel, or test operation is a bug, so it fails at startup. */
export function composeMobileDev(features: readonly MobileDevFeature[]): MobileDev {
  const actions: Partial<Record<MobileControlAction, MobileDevAction>> = {};
  const ipc: Record<string, MobileIpcHandler> = {};
  const testOps: Record<string, MobileDevTestOp> = {};
  const decorators: MobileDevDecorate[] = [];
  for (const feature of features) {
    for (const [action, handler] of Object.entries(feature.actions) as [MobileControlAction, MobileDevAction][]) {
      if (actions[action]) throw new Error(`Two mobile dev features handle ${action}.`);
      actions[action] = handler;
    }
    join(ipc, feature.ipc, "channel");
    join(testOps, feature.testOps, "test operation");
    if (feature.decorate) decorators.push(feature.decorate);
  }
  return {
    actions,
    ipc,
    testOps,
    ...(decorators.length > 0
      ? {
          decorate: (owner: LeaseOwner, action: MobileControlAction, result: unknown) =>
            decorators.reduce((current, decorate) => decorate(owner, action, current), result),
        }
      : {}),
    dispose: async () => {
      await Promise.allSettled(features.map(async (feature) => feature.dispose()));
    },
  };
}

function join<T>(target: Record<string, T>, source: Record<string, T>, kind: string): void {
  for (const [name, value] of Object.entries(source)) {
    if (name in target) throw new Error(`Two mobile dev features define the ${kind} ${name}.`);
    target[name] = value;
  }
}
