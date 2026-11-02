import {
  emulatorPortFor,
  type MetroOwner,
  MOBILE_WORKSPACE_CHANGED_CHANNEL,
  MobileControlDeviceInput,
  MobileTestMetroOwner,
  type MobileWorkspace,
  MobileWorkspaceInput,
  type MobileWorkspaceOpened,
  MobileWorkspaceOpenInput,
  metroOpenUrl,
  metroPortFor,
  type PortWorktree,
} from "@zli-v2/contracts";

import { BrowserControlError } from "../../../browser/BrowserControlActions.js";
import type { MobileDevFeature, MobileDevHost } from "../host.js";
import { metroOwner, type OwnerWorktree } from "./portOwner.js";
import { type ProjectInfo, readProjectInfo } from "./projectInfo.js";

export const WORKSPACE_CHANGED = MOBILE_WORKSPACE_CHANGED_CHANNEL;

/** The runtime hands the desktop full worktree projections, which carry the branch and kind as well. */
type KnownWorktree = PortWorktree & { readonly path: string; readonly branch?: string };

/**
 * Each worktree's own Metro port, who is listening on it, the URL that opens the app on a device against it,
 * and the device the worktree's agent holds.
 */
export function createWorkspace(host: MobileDevHost): MobileDevFeature {
  const fakeOwners = new Map<string, MetroOwner>();
  const ANY = "*";

  const known = (): readonly KnownWorktree[] => host.worktrees();

  const describe = async (worktreeId: string): Promise<MobileWorkspace> => {
    const worktrees = known();
    const worktree = worktrees.find((entry) => entry.worktreeId === worktreeId);
    if (!worktree) throw new BrowserControlError(`ZLI does not know the worktree ${worktreeId}.`, 404);
    const metroPort = metroPortFor(worktreeId, worktrees);
    const emulatorPort = emulatorPortFor(worktreeId, worktrees);
    const owners: OwnerWorktree[] = worktrees.map((entry) => ({
      worktreeId: entry.worktreeId,
      path: entry.path,
      branch: branchOf(entry),
    }));
    const [info, metro] = await Promise.all([
      readProjectInfo(worktree.path, host.fs, host.os).catch((): ProjectInfo => ({ devClient: false })),
      fakeOwners.get(worktreeId) ??
        fakeOwners.get(ANY) ??
        metroOwner(metroPort, worktreeId, owners, host).catch(
          (): MetroOwner => ({ state: "unknown", reason: "The port check failed." }),
        ),
    ]);
    const { scheme, slug } = info;
    const deviceId = host.manager()?.leases.heldBy(`agent:${worktreeId}`)[0];
    return {
      worktreeId,
      branch: branchOf(worktree).slice(0, 300),
      path: worktree.path.slice(0, 1_000),
      ...(worktree.kind === "checkout" ? { checkout: true } : {}),
      metroPort,
      ...(emulatorPort !== undefined ? { emulatorPort } : {}),
      metro,
      devClient: info.devClient,
      ...(scheme ? { scheme } : {}),
      openUrl: metroOpenUrl(metroPort, { devClient: info.devClient, scheme, slug }),
      ...(deviceId ? { deviceId } : {}),
    };
  };

  const open = async (worktreeId: string, deviceId: string): Promise<MobileWorkspaceOpened> => {
    const manager = host.manager();
    if (!manager) throw new BrowserControlError("ZLI's mobile service is still starting. Try again in a moment.", 503);
    const workspace = await describe(worktreeId);
    if (workspace.metro.state === "other-worktree")
      throw new BrowserControlError(`Port ${workspace.metroPort} belongs to ${workspace.metro.branch}.`, 409);
    const result = await manager.openUrl(deviceId, workspace.openUrl, { metroPort: workspace.metroPort });
    return { opened: workspace.openUrl, ...result };
  };

  return {
    actions: {
      mobileworkspace: async (input, context) => {
        const parsed = MobileControlDeviceInput.parse(input ?? {});
        return describe(context.worktreeFor(parsed).worktreeId);
      },
    },
    ipc: {
      "zli:mobile:workspace:get": async (input) => describe(MobileWorkspaceInput.parse(input).worktreeId),
      "zli:mobile:workspace:list": () => Promise.all(known().map((entry) => describe(entry.worktreeId))),
      "zli:mobile:workspace:open": async (input) => {
        const parsed = MobileWorkspaceOpenInput.parse(input);
        return open(parsed.worktreeId, parsed.deviceId);
      },
    },
    decorate: undefined,
    testOps: {
      "metro-owner": (input) => {
        const parsed = MobileTestMetroOwner.parse(input);
        fakeOwners.set(parsed.worktreeId ?? ANY, parsed.owner);
        host.send(WORKSPACE_CHANGED, parsed.worktreeId ? { worktreeId: parsed.worktreeId } : {});
        return { accepted: true };
      },
    },
    dispose() {
      fakeOwners.clear();
    },
  };
}

function branchOf(worktree: KnownWorktree): string {
  return worktree.branch ?? worktree.path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? worktree.worktreeId;
}
