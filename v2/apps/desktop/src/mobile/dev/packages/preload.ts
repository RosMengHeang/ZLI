import { MobilePackageCheck, MobilePackagesInput, MobileProposal } from "@zli-v2/contracts";

import type { PreloadIpc } from "../preloadIpc.js";

/** window.zli.mobile.dev.packages. Part of the preload bundle, so it imports only contracts and preload files. */
export function createPackagesApi(ipc: PreloadIpc) {
  return {
    packages: {
      check: async (worktreeId: string, packages: string[]) =>
        MobilePackageCheck.parse(
          await ipc.invoke("zli:mobile:packages:check", MobilePackagesInput.parse({ worktreeId, packages })),
        ),
      proposeInstall: async (worktreeId: string, packages: string[]) =>
        MobileProposal.parse(
          await ipc.invoke("zli:mobile:packages:propose-install", MobilePackagesInput.parse({ worktreeId, packages })),
        ),
    },
  };
}
