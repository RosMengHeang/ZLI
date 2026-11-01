// @vitest-environment jsdom

import type { MobileProposal } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MobileBridge } from "../../runtime/bridge.js";
import type { MobileDevContext } from "./context.js";
import { MobileProjectView } from "./MobileProjectView.js";
import { ProposalCards } from "./ProposalCards.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const command: MobileProposal = {
  proposalId: "00000000-0000-4000-8000-000000000001",
  worktreeId: "wt-1",
  source: "agent",
  sourceLabel: "Proposed by the agent in feat-login",
  title: "Install expo-camera",
  reason: "The camera screen imports it.",
  action: {
    kind: "command",
    program: "npx",
    args: ["expo", "install", "expo-camera"],
    cwd: "apps/mobile",
    env: { CI: "1" },
  },
  state: "pending",
  createdAt: "2026-01-02T03:04:05.000Z",
};

const block: MobileProposal = {
  ...command,
  proposalId: "00000000-0000-4000-8000-000000000002",
  source: "zli",
  sourceLabel: "From the project check",
  title: "Add mobile notes for agents",
  reason: "",
  action: {
    kind: "file-block",
    file: "AGENTS.md",
    marker: "zli:mobile",
    content: ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n"),
    baseDigest: "absent",
  },
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function fakeProposals(initial: MobileProposal[]) {
  let list = initial;
  const listeners = new Set<(next: MobileProposal[]) => void>();
  const publish = (next: MobileProposal[]) => {
    list = next;
    for (const listener of listeners) listener(next);
  };
  const update = (proposalId: string, patch: Partial<MobileProposal>) => {
    const next = list.map((proposal) => (proposal.proposalId === proposalId ? { ...proposal, ...patch } : proposal));
    publish(next);
    return next.find((proposal) => proposal.proposalId === proposalId) as MobileProposal;
  };
  const proposals = {
    list: vi.fn(async (worktreeId?: string) =>
      list.filter((proposal) => !worktreeId || proposal.worktreeId === worktreeId),
    ),
    accept: vi.fn(async (proposalId: string) => update(proposalId, { state: "started", terminalId: "t-1" })),
    dismiss: vi.fn(async (proposalId: string) => update(proposalId, { state: "dismissed" })),
    onChange: (listener: (next: MobileProposal[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { proposals, publish, update };
}

function contextFor(proposals: ReturnType<typeof fakeProposals>["proposals"], extra: Partial<MobileDevContext> = {}) {
  const context: MobileDevContext = {
    mobile: { dev: { proposals } } as unknown as MobileBridge,
    worktreeId: "wt-1",
    device: undefined,
    online: false,
    agentHolds: false,
    devServers: [],
    onError: vi.fn(),
    onNotice: vi.fn(),
    onOpenTerminal: vi.fn(),
    ...extra,
  };
  return context;
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("proposal cards", () => {
  it("shows who proposed the command, the exact line, and where it runs", async () => {
    const { proposals } = fakeProposals([
      command,
      { ...command, proposalId: "00000000-0000-4000-8000-000000000009", worktreeId: "wt-2" },
    ]);
    const container = await render(<ProposalCards context={contextFor(proposals)} />);
    const cards = container.querySelectorAll("article");
    expect(cards).toHaveLength(1);
    const card = cards[0] as HTMLElement;
    expect(card.textContent).toContain("Proposed by the agent in feat-login");
    expect(card.querySelector("h3")?.textContent).toBe("Install expo-camera");
    expect(card.textContent).toContain("The camera screen imports it.");
    expect(card.querySelector("pre")?.textContent).toBe("CI=1 npx expo install expo-camera");
    expect(card.textContent).toContain("Runs in apps/mobile in a new terminal.");
    expect(proposals.list).toHaveBeenCalledWith("wt-1");
  });

  it("runs a command with only its id, then points to the terminal drawer", async () => {
    const { proposals } = fakeProposals([command]);
    const context = contextFor(proposals);
    const container = await render(<ProposalCards context={context} />);
    await click(button(container, "Run in terminal"));
    expect(proposals.accept).toHaveBeenCalledWith(command.proposalId);
    expect(container.textContent).toContain("Running in the terminal drawer");
    await click(button(container, "Open terminal"));
    expect(context.onOpenTerminal).toHaveBeenCalled();
    await click(button(container, "Dismiss"));
    expect(proposals.dismiss).toHaveBeenCalledWith(command.proposalId);
    expect(container.querySelector("article")).toBeNull();
  });

  it("shows a failure under the card and keeps Run in terminal to try again", async () => {
    const { proposals } = fakeProposals([command]);
    proposals.accept.mockImplementationOnce(async () => {
      throw new Error("ZLI's runtime is still starting.");
    });
    const container = await render(<ProposalCards context={contextFor(proposals)} />);
    await click(button(container, "Run in terminal"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("ZLI's runtime is still starting.");
    expect(button(container, "Run in terminal")).toBeDefined();
  });

  it("shows a file block collapsed to six lines, and says when it is written", async () => {
    const { proposals } = fakeProposals([block]);
    proposals.accept.mockImplementationOnce(async () => ({ ...block, state: "written" }));
    const context = contextFor(proposals);
    const container = await render(<ProposalCards context={context} />);
    expect(container.textContent).toContain("Adds these lines to AGENTS.md:");
    expect(container.querySelector("pre")?.textContent?.split("\n")).toHaveLength(6);
    await click(button(container, "Show all"));
    expect(container.querySelector("pre")?.textContent?.split("\n")).toHaveLength(8);
    await click(button(container, "Write to AGENTS.md"));
    expect(proposals.accept).toHaveBeenCalledWith(block.proposalId);
    expect(context.onNotice).toHaveBeenCalledWith("Updated AGENTS.md.");
  });

  it("shows nothing without a worktree or without the proposals bridge", async () => {
    const { proposals } = fakeProposals([command]);
    const container = await render(<ProposalCards context={contextFor(proposals, { worktreeId: undefined })} />);
    expect(container.textContent).toBe("");
    expect(proposals.list).not.toHaveBeenCalled();
  });
});

describe("project check view", () => {
  it("asks for an agent or worktree first", async () => {
    const { proposals } = fakeProposals([]);
    const container = await render(<MobileProjectView context={contextFor(proposals, { worktreeId: undefined })} />);
    expect(container.textContent).toContain("Open an agent or worktree first");
    expect(container.textContent).toContain("The project check looks at the folder the current agent works in.");
  });
});
