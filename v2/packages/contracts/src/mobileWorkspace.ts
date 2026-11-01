import { z } from "zod";

/** Metro's own port. The project's own checkout keeps it; worktrees get one from METRO_BAND. */
export const METRO_DEFAULT_PORT = 8081;
export const METRO_BAND = { first: 8100, size: 100 } as const;
/** Even console ports 5556 to 5584. 5554 stays free for the person's own emulator. */
export const EMULATOR_BAND = { first: 5556, size: 15 } as const;
/** Set in every terminal and agent of a worktree. RCT_METRO_PORT is what Expo and React Native read. */
export const METRO_ENV_KEYS = ["ZLI_METRO_PORT", "RCT_METRO_PORT"] as const;

/** The fields the port walk reads, so the server, the desktop, and the renderer can each pass what they hold. */
export type PortWorktree = {
  readonly worktreeId: string;
  readonly kind?: string | undefined;
  readonly status: string;
};

/**
 * The worktree's Metro port: 8081 for the project's own checkout, otherwise a port in METRO_BAND picked from a
 * hash of its id. Worktrees are walked in projection order, which is creation order, so on a collision the
 * earlier worktree keeps its port and a new worktree never moves an older one. Pure, so every process agrees.
 */
export function metroPortFor(worktreeId: string, worktrees: readonly PortWorktree[]): number {
  const self = worktrees.find((entry) => entry.worktreeId === worktreeId);
  if (self?.kind === "checkout") return METRO_DEFAULT_PORT;
  const slot = walk(worktreeId, worktrees, METRO_BAND.size);
  return METRO_BAND.first + (slot ?? fnv1a32(worktreeId) % METRO_BAND.size);
}

/** The emulator console port an agent in this worktree boots on, or undefined for the checkout or a full band. */
export function emulatorPortFor(worktreeId: string, worktrees: readonly PortWorktree[]): number | undefined {
  const self = worktrees.find((entry) => entry.worktreeId === worktreeId);
  if (!self || self.kind === "checkout" || self.status === "cancelled") return undefined;
  const slot = walk(worktreeId, worktrees, EMULATOR_BAND.size);
  return slot === undefined ? undefined : EMULATOR_BAND.first + slot * 2;
}

/** The slot the walk gives worktreeId, or undefined when every slot was taken before it (or it is not walked). */
function walk(worktreeId: string, worktrees: readonly PortWorktree[], size: number): number | undefined {
  const taken = new Set<number>();
  for (const entry of worktrees) {
    if (entry.status === "cancelled" || entry.kind === "checkout") continue;
    if (taken.size >= size) return undefined;
    let slot = fnv1a32(entry.worktreeId) % size;
    while (taken.has(slot)) slot = (slot + 1) % size;
    if (entry.worktreeId === worktreeId) return slot;
    taken.add(slot);
  }
  return undefined;
}

/** 32-bit FNV-1a over the UTF-16 code units, which is stable across Node and the browser. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The URL that opens the app on a device against this port: the development build's own link, or Expo Go's. */
export function metroOpenUrl(port: number, app: { devClient: boolean; scheme?: string | undefined }): string {
  if (app.devClient && app.scheme)
    return `${app.scheme}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${port}`)}`;
  return `exp://localhost:${port}`;
}

/** Who listens on a worktree's Metro port. */
export const MetroOwner = z.discriminatedUnion("state", [
  z.object({ state: z.literal("free") }),
  z.object({ state: z.literal("this-worktree"), pid: z.number().int() }),
  z.object({
    state: z.literal("other-worktree"),
    pid: z.number().int(),
    worktreeId: z.string().max(200),
    branch: z.string().max(300),
  }),
  z.object({ state: z.literal("other-process"), pid: z.number().int().optional() }),
  z.object({ state: z.literal("unknown"), reason: z.string().max(200) }),
]);
export type MetroOwner = z.infer<typeof MetroOwner>;

export const MobileWorkspace = z.object({
  worktreeId: z.string().min(1).max(200),
  branch: z.string().max(300),
  /** The worktree's folder, for the Settings list. */
  path: z.string().max(1_000).optional(),
  /** The project's own checkout, which keeps Metro's 8081. */
  checkout: z.boolean().optional(),
  metroPort: z.number().int().min(1_024).max(65_535),
  emulatorPort: z.number().int().optional(),
  metro: MetroOwner,
  devClient: z.boolean(),
  scheme: z.string().max(100).optional(),
  /** The development build or Expo Go URL for this worktree's port. */
  openUrl: z.string().max(500),
  /** The device this worktree's agent holds. */
  deviceId: z.string().optional(),
});
export type MobileWorkspace = z.infer<typeof MobileWorkspace>;
export const MobileWorkspaceList = z.array(MobileWorkspace).max(500);

export const MobileWorkspaceInput = z.object({ worktreeId: z.string().min(1).max(200) });
export type MobileWorkspaceInput = z.infer<typeof MobileWorkspaceInput>;

/** Opens the worktree's own URL on a device. The renderer names the worktree and device, never the URL. */
export const MobileWorkspaceOpenInput = MobileWorkspaceInput.extend({ deviceId: z.string().min(1).max(300) });
export type MobileWorkspaceOpenInput = z.infer<typeof MobileWorkspaceOpenInput>;

export const MobileWorkspaceOpened = z.object({
  opened: z.string().max(500),
  reversedPort: z.number().int().optional(),
  /** The device's localhost:8081 now reaches this port on the computer. */
  mapped8081To: z.number().int().optional(),
});
export type MobileWorkspaceOpened = z.infer<typeof MobileWorkspaceOpened>;

/** Fired when a worktree's workspace may have changed, so open views read it again. */
export const MobileWorkspaceChanged = z.object({ worktreeId: z.string().max(200).optional() });
export type MobileWorkspaceChanged = z.infer<typeof MobileWorkspaceChanged>;

/** e2e: what the port owner check answers for one worktree, or for every worktree without worktreeId. */
export const MobileTestMetroOwner = z.object({ worktreeId: z.string().max(200).optional(), owner: MetroOwner });
export type MobileTestMetroOwner = z.infer<typeof MobileTestMetroOwner>;
