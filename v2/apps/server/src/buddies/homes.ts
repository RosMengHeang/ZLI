import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type BuddyProjection,
  CommandId,
  isBuddyHome,
  type ProjectProjection,
  type RuntimeCommand,
  type RuntimeProjection,
  type WorktreeProjection,
} from "@zli-v2/contracts";

import type { CommandReceipt, Engine } from "../orchestration/Engine.js";
import { stableId } from "./stableId.js";

const README = [
  "# Buddy home",
  "",
  "This folder belongs to one ZLI buddy. Its chat runs here, and so do its web jobs: research, forms, reports.",
  "What it makes for you goes in files/. Its notes for itself go in notes.md.",
  "Its browser keeps its own sign-ins, apart from yours and the other buddies'.",
  "",
].join("\n");

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 24) || "buddy"
  );
}

/**
 * Gives each buddy a home: its own folder under the homes folder, added to ZLI as a worktree of a project
 * the app keeps out of sight. A buddy's chat and web jobs run there, so they never sit in a project, and the
 * browser keeps a profile per worktree, so the buddy's sign-ins stay its own.
 */
export class BuddyHomes {
  constructor(
    private readonly engine: Engine,
    /** The homes folder itself, named BUDDY_HOMES_FOLDER. */
    private readonly root: string,
  ) {}

  /** The homes project, added once and kept out of Git. */
  async project(state: RuntimeProjection): Promise<ProjectProjection | undefined> {
    let project = state.projects.find((entry) => isBuddyHome(entry));
    if (!project) {
      await mkdir(this.root, { recursive: true });
      await this.dispatch({ type: "project.register", path: this.root } as RuntimeCommand, `buddy-homes:${this.root}`);
      project = (await this.engine.projection()).projects.find((entry) => isBuddyHome(entry));
      if (!project) return undefined;
    }
    if (project.git !== false)
      await this.dispatch(
        { type: "project.git", projectId: project.projectId, git: false } as RuntimeCommand,
        `buddy-homes-git:${project.projectId}`,
      );
    if (project.agentsTrusted !== true)
      await this.dispatch(
        { type: "project.agents", projectId: project.projectId, trusted: true } as RuntimeCommand,
        `buddy-homes-trust:${project.projectId}`,
      );
    return project;
  }

  /** The buddy's home, made the first time it is needed. Undefined when it could not be made. */
  async home(state: RuntimeProjection, buddy: BuddyProjection): Promise<WorktreeProjection | undefined> {
    const worktreeId = stableId(`buddy-home:${buddy.buddyId}`);
    const ready = (current: RuntimeProjection) =>
      current.worktrees.find((worktree) => worktree.worktreeId === worktreeId && worktree.status === "ready");
    let worktree = ready(state);
    if (!worktree) {
      const project = await this.project(state);
      if (!project) return undefined;
      const path = join(project.path, `${slug(buddy.name)}-${buddy.buddyId.slice(0, 6)}`);
      await mkdir(join(path, "files"), { recursive: true });
      await writeFile(join(path, "README.md"), README, { flag: "wx" }).catch(() => undefined);
      await writeFile(join(path, "notes.md"), `# ${buddy.name}'s notes\n\n`, { flag: "wx" }).catch(() => undefined);
      await this.dispatch(
        { type: "worktree.import", worktreeId, projectId: project.projectId, path, branch: "HEAD" } as RuntimeCommand,
        `buddy-home-import:${worktreeId}`,
      );
      worktree = ready(await this.engine.projection());
      if (!worktree) return undefined;
    }
    if (buddy.home?.worktreeId !== worktree.worktreeId || buddy.home.path !== worktree.path)
      await this.dispatch(
        { type: "buddy.home", buddyId: buddy.buddyId, worktreeId: worktree.worktreeId, path: worktree.path },
        `buddy-home-set:${buddy.buddyId}:${worktree.worktreeId}`,
      );
    return worktree;
  }

  private dispatch(command: RuntimeCommand, key: string): Promise<CommandReceipt> {
    return this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(stableId(key)), command });
  }
}
