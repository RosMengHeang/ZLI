import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import {
  type MobileProposal,
  MobileProposalAction,
  type MobileProposalActionInput,
  type MobileProposalCommand,
  PROPOSAL_BLOCK_END,
  PROPOSAL_BLOCK_START,
  type RpcResponse,
} from "@zli-v2/contracts";

/** A proposal ZLI refused, with the HTTP status an agent's call gets for it. */
export class ProposalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

export type ProposalFiles = {
  /** The file's text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  isLink(path: string): Promise<boolean>;
  /** Writes through a temporary file and a rename, so a reader never sees half a file. */
  writeAtomic(path: string, text: string): Promise<void>;
};

export const nodeProposalFiles: ProposalFiles = {
  read: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  },
  isLink: async (path) => {
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch {
      return false;
    }
  },
  writeAtomic: async (path, text) => {
    const temporary = `${path}.zli-${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temporary, text, "utf8");
      await rename(temporary, path);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  },
};

export type ProposalRuntimeCommand = (request: {
  protocolVersion: 1;
  commandId: string;
  command: Record<string, unknown>;
}) => Promise<RpcResponse>;

export type ProposalStoreOptions = {
  worktrees(): readonly { readonly worktreeId: string; readonly path: string }[];
  /** Sends a command to ZLI's runtime. Commands run in a terminal it creates, whose environment it cleans. */
  command: ProposalRuntimeCommand;
  onChange?(proposals: MobileProposal[]): void;
  readonly platform?: NodeJS.Platform;
  readonly files?: ProposalFiles;
  readonly newId?: () => string;
  readonly now?: () => Date;
};

export type ProposalInput = {
  worktreeId: string;
  source: MobileProposal["source"];
  sourceLabel: string;
  title: string;
  reason: string;
  action: MobileProposalActionInput;
};

const MAX_PER_WORKTREE = 20;
const MAX_PENDING_FROM_AGENTS = 5;
const OPEN_STATES: ReadonlySet<MobileProposal["state"]> = new Set(["pending", "failed"]);

/** The digest a file-block proposal records as baseDigest: sha256 hex of the file's text, or "absent". */
export function proposalDigest(text: string | undefined): string {
  return text === undefined ? "absent" : createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Normalizes a proposal's folder to a path relative to the worktree, with forward slashes, or "." for the root.
 * Absolute paths and ".." are refused, so a proposal can only run inside its worktree.
 */
export function proposalFolder(folder: string): string {
  const slashed = folder.trim().replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/u.test(slashed))
    throw new ProposalError("A proposal's folder must be relative to the worktree.");
  const parts = slashed.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new ProposalError("A proposal's folder cannot leave the worktree.");
  return parts.length === 0 ? "." : parts.join("/");
}

/** The shell and arguments a terminal runs the command with. Every argument is quoted as one word. */
export function proposalShell(
  action: Pick<MobileProposalCommand, "program" | "args" | "env">,
  platform: NodeJS.Platform,
): { shell: string; args: string[] } {
  const words = [action.program, ...action.args];
  const env = Object.entries(action.env ?? {});
  if (platform === "win32") {
    // cmd.exe expands %NAME% even inside quotes; ^ and the rest are literal there.
    const expanding = words.find((word) => word.includes("%"));
    if (expanding !== undefined)
      throw new ProposalError(`Windows would read the % in ${expanding} as a variable, so ZLI does not run it.`);
    const line = `${env.map(([key, value]) => `set ${key}=${value}&& `).join("")}${words.map((word) => `"${word}"`).join(" ")}`;
    return { shell: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`] };
  }
  const line = `${env.map(([key, value]) => `${key}=${value} `).join("")}${words.map(posixQuote).join(" ")}`;
  return { shell: "/bin/bash", args: ["-lc", line] };
}

function posixQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Content may not carry a marker itself, or a later write could mistake it for the block's edge. */
function refuseMarkerContent(content: string): void {
  if (content.includes(PROPOSAL_BLOCK_START) || content.includes(PROPOSAL_BLOCK_END))
    throw new ProposalError(
      "The proposed text contains one of ZLI's block markers, so ZLI cannot place it between them.",
    );
}

/**
 * The file with ZLI's block set to content: replaced between the markers, appended after one blank line, or as a
 * new file. The file's line endings are kept. A file whose markers are not exactly one start followed by one end
 * is refused, so a stray or doubled marker never makes a write delete the text around it.
 */
export function withProposalBlock(existing: string | undefined, content: string): string {
  refuseMarkerContent(content);
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const body = content.replaceAll("\r\n", "\n").replace(/\n+$/u, "").split("\n").join(eol);
  const block = `${PROPOSAL_BLOCK_START}${eol}${body ? `${body}${eol}` : ""}${PROPOSAL_BLOCK_END}`;
  if (existing === undefined) return `${block}${eol}`;
  const starts = existing.split(PROPOSAL_BLOCK_START).length - 1;
  const ends = existing.split(PROPOSAL_BLOCK_END).length - 1;
  const start = existing.indexOf(PROPOSAL_BLOCK_START);
  const end = existing.indexOf(PROPOSAL_BLOCK_END);
  if (starts === 1 && ends === 1 && start < end)
    return `${existing.slice(0, start)}${block}${existing.slice(end + PROPOSAL_BLOCK_END.length)}`;
  if (starts === 0 && ends === 0) {
    const kept = existing.replace(/(\r?\n)+$/u, "");
    return kept ? `${kept}${eol}${eol}${block}${eol}` : `${block}${eol}`;
  }
  throw new ProposalError(
    "This file's zli:mobile markers are not one start marker followed by one end marker, so ZLI wrote nothing. Fix or remove the markers by hand.",
  );
}

/**
 * Commands and file changes waiting for the person. Nothing here runs on its own: accept is only reached from the
 * person's click, by proposal id, so what runs is exactly what the card showed.
 */
export class ProposalStore {
  readonly #options: ProposalStoreOptions;
  readonly #files: ProposalFiles;
  readonly #platform: NodeJS.Platform;
  #proposals: MobileProposal[] = [];
  readonly #accepting = new Set<string>();

  constructor(options: ProposalStoreOptions) {
    this.#options = options;
    this.#files = options.files ?? nodeProposalFiles;
    this.#platform = options.platform ?? process.platform;
  }

  list(worktreeId?: string): MobileProposal[] {
    return this.#proposals.filter((proposal) => worktreeId === undefined || proposal.worktreeId === worktreeId);
  }

  get(proposalId: string): MobileProposal | undefined {
    return this.#proposals.find((proposal) => proposal.proposalId === proposalId);
  }

  create(input: ProposalInput): MobileProposal {
    if (!this.#worktreePath(input.worktreeId))
      throw new ProposalError("That worktree is not in ZLI, so nothing can be proposed for it.", 404);
    const parsed = MobileProposalAction.safeParse(input.action);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
      throw new ProposalError(`ZLI cannot propose that${where}: ${issue?.message ?? "the action is not valid"}.`);
    }
    const action =
      parsed.data.kind === "command" ? { ...parsed.data, cwd: proposalFolder(parsed.data.cwd) } : parsed.data;
    if (action.kind === "file-block") refuseMarkerContent(action.content);
    if (input.source === "agent") {
      const waiting = this.#proposals.filter(
        (proposal) =>
          proposal.worktreeId === input.worktreeId && proposal.source === "agent" && proposal.state === "pending",
      );
      if (waiting.length >= MAX_PENDING_FROM_AGENTS)
        throw new ProposalError(
          `The person already has ${MAX_PENDING_FROM_AGENTS} proposals from agents waiting in this worktree. Wait until they run or dismiss one.`,
          429,
        );
    }
    const proposal: MobileProposal = {
      proposalId: this.#options.newId?.() ?? randomUUID(),
      worktreeId: input.worktreeId,
      source: input.source,
      sourceLabel: input.sourceLabel.slice(0, 120),
      title: input.title.trim().slice(0, 120) || "Proposed command",
      reason: input.reason.slice(0, 600),
      action,
      state: "pending",
      createdAt: (this.#options.now?.() ?? new Date()).toISOString(),
    };
    this.#proposals = trimWorktree([...this.#proposals, proposal], input.worktreeId);
    this.#changed();
    return proposal;
  }

  dismiss(proposalId: string): MobileProposal {
    const proposal = this.#require(proposalId);
    if (proposal.state === "dismissed") return proposal;
    return this.#update(proposalId, { state: "dismissed" });
  }

  /** Runs the command in a new terminal, or writes the file block. Only the person's click reaches this. */
  async accept(proposalId: string): Promise<MobileProposal> {
    const proposal = this.#require(proposalId);
    if (!OPEN_STATES.has(proposal.state))
      throw new ProposalError(
        proposal.state === "dismissed" ? "This proposal was dismissed." : "This proposal already ran.",
        409,
      );
    if (this.#accepting.has(proposalId)) throw new ProposalError("This proposal is already starting.", 409);
    this.#accepting.add(proposalId);
    try {
      const { action } = proposal;
      return action.kind === "command"
        ? await this.#runCommand(proposal, action)
        : await this.#writeBlock(proposal, action);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return this.#update(proposalId, { state: "failed", error: message.slice(0, 500) });
    } finally {
      this.#accepting.delete(proposalId);
    }
  }

  async #runCommand(proposal: MobileProposal, action: MobileProposalCommand): Promise<MobileProposal> {
    const root = this.#worktreePath(proposal.worktreeId);
    if (!root) throw new Error("This worktree is no longer in ZLI.");
    const path = this.#platform === "win32" ? win32 : posix;
    const folder = proposalFolder(action.cwd);
    const cwd = folder === "." ? root : path.resolve(root, ...folder.split("/"));
    const inside = path.relative(root, cwd);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The folder is outside the worktree.");
    const terminalId = this.#options.newId?.() ?? randomUUID();
    const response = await this.#options.command({
      protocolVersion: 1,
      commandId: this.#options.newId?.() ?? randomUUID(),
      command: {
        type: "terminal.create",
        terminalId,
        worktreeId: proposal.worktreeId,
        cwd,
        title: proposal.title,
        cols: 120,
        rows: 32,
        ...proposalShell(action, this.#platform),
      },
    });
    if (!response.accepted) throw new Error(response.error.message);
    return this.#update(proposal.proposalId, { state: "started", terminalId, error: undefined });
  }

  async #writeBlock(
    proposal: MobileProposal,
    action: Extract<MobileProposal["action"], { kind: "file-block" }>,
  ): Promise<MobileProposal> {
    const root = this.#worktreePath(proposal.worktreeId);
    if (!root) throw new Error("This worktree is no longer in ZLI.");
    const target = (this.#platform === "win32" ? win32 : posix).join(root, action.file);
    if (await this.#files.isLink(target))
      throw new Error(`${action.file} is a link to another file, so ZLI does not write through it.`);
    const existing = await this.#files.read(target);
    if (proposalDigest(existing) !== action.baseDigest)
      throw new Error(`${action.file} changed after ZLI showed this change. Check again to see the new version.`);
    await this.#files.writeAtomic(target, withProposalBlock(existing, action.content));
    return this.#update(proposal.proposalId, { state: "written", error: undefined });
  }

  #worktreePath(worktreeId: string): string | undefined {
    return this.#options.worktrees().find((worktree) => worktree.worktreeId === worktreeId)?.path;
  }

  #require(proposalId: string): MobileProposal {
    const proposal = this.get(proposalId);
    if (!proposal) throw new ProposalError("ZLI has no such proposal. It may have been cleared.", 404);
    return proposal;
  }

  /** An error of undefined in the patch clears the proposal's error; leaving it out keeps it. */
  #update(
    proposalId: string,
    patch: { state: MobileProposal["state"]; error?: string | undefined; terminalId?: string },
  ): MobileProposal {
    let updated: MobileProposal | undefined;
    this.#proposals = this.#proposals.map((proposal) => {
      if (proposal.proposalId !== proposalId) return proposal;
      const { error, ...rest } = { ...proposal, ...patch };
      updated = error === undefined ? rest : { ...rest, error };
      return updated;
    });
    if (!updated) throw new ProposalError("ZLI has no such proposal. It may have been cleared.", 404);
    this.#changed();
    return updated;
  }

  #changed(): void {
    this.#options.onChange?.(this.list());
  }
}

/** Keeps the newest proposals of a worktree, dropping finished ones before any that still wait. */
function trimWorktree(proposals: MobileProposal[], worktreeId: string): MobileProposal[] {
  const mine = proposals.filter((proposal) => proposal.worktreeId === worktreeId);
  const extra = mine.length - MAX_PER_WORKTREE;
  if (extra <= 0) return proposals;
  const finished = (proposal: MobileProposal) => proposal.state === "dismissed" || proposal.state === "written";
  const order = [...mine.filter(finished), ...mine.filter((proposal) => !finished(proposal))];
  const drop = new Set(order.slice(0, extra).map((proposal) => proposal.proposalId));
  return proposals.filter((proposal) => !drop.has(proposal.proposalId));
}
