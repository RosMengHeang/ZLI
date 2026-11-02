import type { MobileWorkspace, MobileWorkspaceChanged, MobileWorkspaceOpened } from "@zli-v2/contracts";

/** Each worktree's Metro port, who listens on it, and the URL that opens the app against it. */
export type WorkspaceApi = {
  get(worktreeId: string): Promise<MobileWorkspace>;
  /** Every worktree ZLI knows, for Settings. */
  list(): Promise<MobileWorkspace[]>;
  /** Opens the worktree's own URL on the device. The main process picks the URL, never the renderer. */
  open(worktreeId: string, deviceId: string): Promise<MobileWorkspaceOpened>;
  /** Fires when a worktree's workspace may have changed; without worktreeId, any of them. */
  onChange(listener: (event: MobileWorkspaceChanged) => void): () => void;
};

/** window.zli.mobile.dev.workspace. Absent in builds and test bridges without it. */
export type WorkspaceBridge = { workspace?: WorkspaceApi };
