import { MobileProposal, MobileProposalIdInput, MobileProposalList, MobileProposalListInput } from "@zli-v2/contracts";

import { listenParsed, type PreloadIpc } from "./preloadIpc.js";

/** The Mobile panel's proposal cards. Accept and dismiss take only an id, so the renderer cannot change what runs. */
export function createProposalApi(ipc: PreloadIpc) {
  return {
    list: async (worktreeId?: string) =>
      MobileProposalList.parse(
        await ipc.invoke("zli:mobile:proposals:list", MobileProposalListInput.parse(worktreeId ? { worktreeId } : {})),
      ),
    accept: async (proposalId: string) =>
      MobileProposal.parse(
        await ipc.invoke("zli:mobile:proposals:accept", MobileProposalIdInput.parse({ proposalId })),
      ),
    dismiss: async (proposalId: string) =>
      MobileProposal.parse(
        await ipc.invoke("zli:mobile:proposals:dismiss", MobileProposalIdInput.parse({ proposalId })),
      ),
    onChange: listenParsed(ipc, "zli:mobile:proposals", MobileProposalList),
  };
}
