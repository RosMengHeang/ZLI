import {
  MobileWorkspace,
  MobileWorkspaceChanged,
  MobileWorkspaceInput,
  MobileWorkspaceList,
  MobileWorkspaceOpened,
  MobileWorkspaceOpenInput,
} from "@zli-v2/contracts";

import { listenParsed, type PreloadIpc } from "../preloadIpc.js";

/**
 * window.zli.mobile.dev.workspace: each worktree's Metro port and its owner. Open takes only the worktree and the
 * device, so the renderer cannot choose the URL that is opened.
 */
export function createWorkspaceApi(ipc: PreloadIpc) {
  return {
    workspace: {
      get: async (worktreeId: string) =>
        MobileWorkspace.parse(await ipc.invoke("zli:mobile:workspace:get", MobileWorkspaceInput.parse({ worktreeId }))),
      list: async () => MobileWorkspaceList.parse(await ipc.invoke("zli:mobile:workspace:list")),
      open: async (worktreeId: string, deviceId: string) =>
        MobileWorkspaceOpened.parse(
          await ipc.invoke("zli:mobile:workspace:open", MobileWorkspaceOpenInput.parse({ worktreeId, deviceId })),
        ),
      onChange: listenParsed(ipc, "zli:mobile:workspace:changed", MobileWorkspaceChanged),
    },
  };
}
