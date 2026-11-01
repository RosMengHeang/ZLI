import { PROPOSAL_BLOCK_END, PROPOSAL_BLOCK_START } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { proposalDigest, proposalFolder, proposalShell, withProposalBlock } from "./ProposalStore.js";
import { createTestDevHost } from "./testHost.js";

const command = (args: string[], extra: Record<string, unknown> = {}) => ({
  worktreeId: "wt-1",
  source: "agent" as const,
  sourceLabel: "Proposed by the agent in app",
  title: "Install packages",
  reason: "The lockfile changed.",
  action: { kind: "command" as const, program: "npm" as const, args, ...extra },
});

describe("proposal shell lines", () => {
  it("quotes every argument as one word on macOS and Linux, with env as a prefix", () => {
    expect(proposalShell({ program: "npx", args: ["expo", "install", "--fix"], env: { CI: "1" } }, "linux")).toEqual({
      shell: "/bin/bash",
      args: ["-lc", "CI=1 'npx' 'expo' 'install' '--fix'"],
    });
  });

  it("quotes every argument for cmd.exe on Windows and refuses %", () => {
    expect(proposalShell({ program: "npm", args: ["install"], env: { CI: "1" } }, "win32")).toEqual({
      shell: "cmd.exe",
      args: ["/d", "/s", "/c", '"set CI=1&& "npm" "install""'],
    });
    expect(() => proposalShell({ program: "npm", args: ["%PATH%"] }, "win32")).toThrow(/variable/u);
  });

  it("keeps folders inside the worktree", () => {
    expect(proposalFolder("./apps//mobile/")).toBe("apps/mobile");
    expect(proposalFolder(".")).toBe(".");
    expect(() => proposalFolder("../other")).toThrow(/cannot leave/u);
    expect(() => proposalFolder("apps/../../x")).toThrow(/cannot leave/u);
    expect(() => proposalFolder("/etc")).toThrow(/relative/u);
    expect(() => proposalFolder("C:\\Windows")).toThrow(/relative/u);
  });
});

describe("proposal store", () => {
  it("refuses programs outside the list, unsafe arguments, and folders outside the worktree", () => {
    const { proposals } = createTestDevHost();
    expect(() =>
      proposals.create({ ...command([]), action: { kind: "command", program: "rm" as "npm", args: [] } }),
    ).toThrow();
    expect(() => proposals.create(command(["install; reboot"]))).toThrow();
    expect(() => proposals.create(command(["it's"]))).toThrow();
    expect(() => proposals.create(command(["install"], { cwd: "../x" }))).toThrow(/cannot leave/u);
    expect(() => proposals.create(command(["install"], { cwd: "/tmp" }))).toThrow(/relative/u);
    expect(() => proposals.create({ ...command(["install"]), worktreeId: "wt-9" })).toThrow(/not in ZLI/u);
    expect(proposals.list()).toEqual([]);
  });

  it("lets an agent have at most five waiting proposals per worktree", () => {
    const { proposals } = createTestDevHost();
    for (let index = 0; index < 5; index += 1) proposals.create(command(["install"]));
    expect(() => proposals.create(command(["install"]))).toThrow(expect.objectContaining({ status: 429 }));
    proposals.create({ ...command(["install"]), source: "zli" });
    proposals.dismiss(proposals.list()[0]?.proposalId ?? "");
    expect(proposals.create(command(["install"])).state).toBe("pending");
  });

  it("keeps at most twenty proposals per worktree, dropping finished ones first", () => {
    const { proposals } = createTestDevHost();
    const first = proposals.create({ ...command(["first"]), source: "zli" });
    const dismissed = proposals.create({ ...command(["dismissed"]), source: "zli" });
    proposals.dismiss(dismissed.proposalId);
    for (let index = 0; index < 19; index += 1) proposals.create({ ...command(["more"]), source: "zli" });
    const ids = proposals.list("wt-1").map((proposal) => proposal.proposalId);
    expect(ids).toHaveLength(20);
    expect(ids).toContain(first.proposalId);
    expect(ids).not.toContain(dismissed.proposalId);
  });

  it("runs an accepted command in a new terminal in its folder, with no extra environment", async () => {
    const host = createTestDevHost();
    const proposal = host.proposals.create(command(["install"], { cwd: "apps/mobile", env: { CI: "1" } }));
    const started = await host.proposals.accept(proposal.proposalId);
    expect(started).toMatchObject({ state: "started", terminalId: expect.any(String) });
    expect(host.commands).toHaveLength(1);
    const sent = host.commands[0]?.command;
    expect(sent).toEqual({
      type: "terminal.create",
      terminalId: started.terminalId,
      worktreeId: "wt-1",
      cwd: "/repo/app/apps/mobile",
      title: "Install packages",
      cols: 120,
      rows: 32,
      shell: "/bin/bash",
      args: ["-lc", "CI=1 'npm' 'install'"],
    });
    // The runtime's terminal environment drops ZLI's private variables; a proposal must not add any back.
    expect(sent).not.toHaveProperty("envOverrides");
    await expect(host.proposals.accept(proposal.proposalId)).rejects.toMatchObject({ status: 409 });
    expect(host.commands).toHaveLength(1);
  });

  it("marks the proposal failed with the runtime's reason, and lets the person try again", async () => {
    let refuse = true;
    const host = createTestDevHost({
      answer: () =>
        refuse ? { accepted: false, error: { code: "unavailable", message: "No shell.", retryable: false } } : {},
    });
    const proposal = host.proposals.create(command(["install"]));
    expect(await host.proposals.accept(proposal.proposalId)).toMatchObject({ state: "failed", error: "No shell." });
    refuse = false;
    const retried = await host.proposals.accept(proposal.proposalId);
    expect(retried.state).toBe("started");
    expect(retried).not.toHaveProperty("error");
  });

  it("refuses to run or dismiss what is not there, and sends the full list on every change", async () => {
    const host = createTestDevHost();
    await expect(host.proposals.accept("00000000-0000-4000-8000-0000000000ff")).rejects.toMatchObject({ status: 404 });
    const proposal = host.proposals.create(command(["install"]));
    host.proposals.dismiss(proposal.proposalId);
    await expect(host.proposals.accept(proposal.proposalId)).rejects.toThrow(/dismissed/u);
    expect(host.sent.map((entry) => (entry.payload as { state: string }[]).map((item) => item.state))).toEqual([
      ["pending"],
      ["dismissed"],
    ]);
  });
});

describe("file-block proposals", () => {
  const block = (content: string, baseDigest: string) => ({
    worktreeId: "wt-1",
    source: "zli" as const,
    sourceLabel: "From the project check",
    title: "Add mobile notes for agents",
    reason: "",
    action: {
      kind: "file-block" as const,
      file: "AGENTS.md" as const,
      marker: "zli:mobile" as const,
      content,
      baseDigest,
    },
  });

  it("creates the file when it does not exist", async () => {
    const host = createTestDevHost();
    const proposal = host.proposals.create(block("Use port 8082.", "absent"));
    expect((await host.proposals.accept(proposal.proposalId)).state).toBe("written");
    expect(host.files.get("/repo/app/AGENTS.md")).toBe(
      `${PROPOSAL_BLOCK_START}\nUse port 8082.\n${PROPOSAL_BLOCK_END}\n`,
    );
  });

  it("replaces the text between the markers and keeps the rest", async () => {
    const before = `# Notes\n\n${PROPOSAL_BLOCK_START}\nold\n${PROPOSAL_BLOCK_END}\n\nMore.\n`;
    const host = createTestDevHost({ files: { "/repo/app/AGENTS.md": before } });
    const proposal = host.proposals.create(block("new", proposalDigest(before)));
    await host.proposals.accept(proposal.proposalId);
    expect(host.files.get("/repo/app/AGENTS.md")).toBe(
      `# Notes\n\n${PROPOSAL_BLOCK_START}\nnew\n${PROPOSAL_BLOCK_END}\n\nMore.\n`,
    );
  });

  it("appends the block after one blank line, keeping CRLF line endings", async () => {
    const before = "# Notes\r\nKeep this.\r\n\r\n";
    const host = createTestDevHost({ files: { "/repo/app/AGENTS.md": before } });
    const proposal = host.proposals.create(block("one\ntwo", proposalDigest(before)));
    await host.proposals.accept(proposal.proposalId);
    expect(host.files.get("/repo/app/AGENTS.md")).toBe(
      `# Notes\r\nKeep this.\r\n\r\n${PROPOSAL_BLOCK_START}\r\none\r\ntwo\r\n${PROPOSAL_BLOCK_END}\r\n`,
    );
  });

  it("refuses to write when the file changed after the proposal was made", async () => {
    const host = createTestDevHost({ files: { "/repo/app/AGENTS.md": "# Notes\n" } });
    const proposal = host.proposals.create(block("new", proposalDigest("# Notes\n")));
    host.files.set("/repo/app/AGENTS.md", "# Notes, edited\n");
    expect(await host.proposals.accept(proposal.proposalId)).toMatchObject({
      state: "failed",
      error: "AGENTS.md changed after ZLI showed this change. Check again to see the new version.",
    });
    expect(host.files.get("/repo/app/AGENTS.md")).toBe("# Notes, edited\n");
  });

  it("writes an empty block when there is no content", () => {
    expect(withProposalBlock(undefined, "")).toBe(`${PROPOSAL_BLOCK_START}\n${PROPOSAL_BLOCK_END}\n`);
  });

  it("refuses content that carries a marker, at propose time and at write time", () => {
    const host = createTestDevHost();
    expect(() => host.proposals.create(block(`see ${PROPOSAL_BLOCK_END} here`, "absent"))).toThrow(/markers/u);
    expect(() => withProposalBlock(undefined, `x\n${PROPOSAL_BLOCK_START}`)).toThrow(/markers/u);
  });

  it("refuses a file whose markers do not pair up, and keeps every byte", async () => {
    const broken = [
      `# Notes\n\n${PROPOSAL_BLOCK_START}\nold\n`,
      `${PROPOSAL_BLOCK_START}\nold\n${PROPOSAL_BLOCK_END}\n${PROPOSAL_BLOCK_START}\n`,
      `${PROPOSAL_BLOCK_END}\n${PROPOSAL_BLOCK_START}\n`,
    ];
    for (const before of broken) {
      const host = createTestDevHost({ files: { "/repo/app/AGENTS.md": before } });
      const proposal = host.proposals.create(block("new", proposalDigest(before)));
      expect(await host.proposals.accept(proposal.proposalId)).toMatchObject({
        state: "failed",
        error: expect.stringMatching(/markers/u),
      });
      expect(host.files.get("/repo/app/AGENTS.md")).toBe(before);
    }
  });
});
