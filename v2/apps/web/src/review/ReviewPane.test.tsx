// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ReviewPane } from "./ReviewPane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktree = {
  worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000101"),
  projectId,
  path: "C:/app",
  branch: "HEAD",
  status: "ready" as const,
  kind: "checkout" as const,
};
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

type Command = { type: string } & Record<string, unknown>;

async function render(
  git: boolean | undefined,
  handle: (command: Command) => unknown = () => undefined,
  reviews?: RuntimeProjection["reviews"],
) {
  const commands: Command[] = [];
  const projection = {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "C:/app", name: "app", ...(git === undefined ? {} : { git }) }],
    worktrees: [worktree],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    ...(reviews ? { reviews } : {}),
  } as RuntimeProjection;
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Command }) => {
        commands.push(request.command);
        const result = handle(request.command);
        return { commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true, result };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <ReviewPane worktree={worktree} />
      </RuntimeProvider>,
    );
  });
  return { container, commands };
}

describe("ReviewPane", () => {
  it("explains that changes need Git in a folder without it", async () => {
    const { container } = await render(false);

    expect(container.textContent).toContain("This folder is not a Git repository");
    expect(container.textContent).not.toContain("Refresh changes");
  });

  it("offers a refresh in a Git repository", async () => {
    const { container } = await render(undefined);

    expect(container.textContent).toContain("Refresh changes");
  });

  it("picks the comparison branch from the repository's branches", async () => {
    const { container, commands } = await render(undefined, (command) =>
      command.type === "review.git.branches"
        ? { current: "feature", defaultBranch: "trunk", local: ["feature", "trunk"], remote: ["trunk"] }
        : undefined,
    );

    expect(commands.map((command) => command.type)).toContain("review.git.branches");
    const picker = container.querySelector<HTMLButtonElement>('button[aria-label^="Compare against"]');
    expect(picker?.getAttribute("aria-label")).toBe("Compare against: trunk");
    expect(container.querySelector("input.is-mono")).toBeNull();
    await act(async () => picker?.click());
    const options = [...document.querySelectorAll('[role="option"]')].map((option) =>
      option.getAttribute("data-label"),
    );
    expect(options).toEqual(["trunk", "origin/trunk"]);
  });

  it("pulls the branch and says how many commits arrived", async () => {
    const { container, commands } = await render(undefined, (command) =>
      command.type === "review.git.pull"
        ? { branch: "feature", commits: 2 }
        : command.type === "review.git.branches"
          ? { local: ["feature", "main"], remote: [] }
          : undefined,
    );
    const pull = [...container.querySelectorAll("button")].find((button) => button.textContent === "Pull");
    await act(async () => pull?.click());

    expect(commands.map((command) => command.type)).toContain("review.git.pull");
    expect(container.textContent).toContain("Pulled 2 commits into feature.");
  });
});

const UNSTAGED_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+TWO",
  "@@ -9,2 +9,3 @@ function nine() {",
  " nine",
  "+nine and a half",
  " ten",
  "",
].join("\n");

function changesReview(diff = false): NonNullable<RuntimeProjection["reviews"]> {
  return [
    {
      worktreeId: worktree.worktreeId,
      baseRef: "main",
      branch: "feature",
      state: "changes",
      files: [
        {
          path: "README.md",
          kind: "modified",
          staged: true,
          unstaged: false,
          additions: 1,
          deletions: 0,
          binary: false,
        },
        {
          path: "notes.txt",
          kind: "untracked",
          staged: false,
          unstaged: true,
          additions: 2,
          deletions: 0,
          binary: false,
        },
        {
          path: "src/app.ts",
          kind: "modified",
          staged: true,
          unstaged: true,
          additions: 2,
          deletions: 1,
          binary: false,
        },
        {
          path: "done.ts",
          kind: "modified",
          staged: false,
          unstaged: false,
          additions: 4,
          deletions: 0,
          binary: false,
        },
      ],
      conflictFiles: [],
      ...(diff
        ? {
            diff: {
              path: "src/app.ts",
              binary: false,
              patch: UNSTAGED_PATCH,
              truncated: false,
              stagedPatch: "",
              unstagedPatch: UNSTAGED_PATCH,
              generatedAt: "2025-01-01T00:00:00.000Z",
            },
          }
        : {}),
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  ];
}

/** Answers like the runtime does for the commands the Changes panel sends on its own. */
function gitReplies(command: Command): unknown {
  if (command.type === "review.git.branches") return { local: ["feature", "main"], remote: [] };
  if (command.type === "review.git.stashList") return { stashes: [] };
  if (["review.git.stage", "review.git.unstage", "review.git.discard", "review.git.hunk"].includes(command.type)) {
    return { ok: true };
  }
  return undefined;
}

const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
  );

describe("ReviewPane staging", () => {
  it("shows each file's staging state and commits only staged files when some are staged", async () => {
    const { container } = await render(undefined, () => undefined, changesReview());
    const box = (path: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Stage ${path}"]`);

    expect(box("README.md")?.checked).toBe(true);
    expect(box("notes.txt")?.checked).toBe(false);
    expect(box("src/app.ts")?.indeterminate).toBe(true);
    expect(box("done.ts")).toBeNull();
    expect(container.textContent).toContain("4 changed files, 2 staged");
    expect(button(container, "Commit 2 staged files")).toBeDefined();
    expect(button(container, "Discard changes to done.ts")).toBeUndefined();
  });

  it("stages and unstages files, then refreshes against the current base", async () => {
    const { container, commands } = await render(undefined, gitReplies, changesReview());
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Stage notes.txt"]')?.click());
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Stage README.md"]')?.click());
    await act(async () => button(container, "Stage all")?.click());

    const changes = commands.filter((command) =>
      command.type.startsWith("review.git.")
        ? !["review.git.stashList", "review.git.branches"].includes(command.type)
        : command.type === "review.refresh",
    );
    expect(changes).toEqual([
      expect.objectContaining({ type: "review.git.stage", paths: ["notes.txt"] }),
      expect.objectContaining({ type: "review.refresh", baseRef: "main" }),
      expect.objectContaining({ type: "review.git.unstage", paths: ["README.md"] }),
      expect.objectContaining({ type: "review.refresh", baseRef: "main" }),
      expect.not.objectContaining({ paths: expect.anything() }),
      expect.objectContaining({ type: "review.refresh" }),
    ]);
    expect(changes[4]?.type).toBe("review.git.stage");
  });

  it("asks before discarding a file and deletes an untracked one only after confirming", async () => {
    const { container, commands } = await render(undefined, gitReplies, changesReview());
    await act(async () => button(container, "Discard changes to notes.txt")?.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Delete notes.txt?");
    expect(dialog?.textContent).toContain("This cannot be undone.");
    expect(commands.some((command) => command.type === "review.git.discard")).toBe(false);
    await act(async () => button(document, "Delete file")?.click());

    expect(commands).toContainEqual(expect.objectContaining({ type: "review.git.discard", path: "notes.txt" }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Discarded the changes to notes.txt.");
  });

  it("stages one hunk of the unstaged diff with the text it showed", async () => {
    const { container, commands } = await render(undefined, gitReplies, changesReview(true));
    const parts = container.querySelector('fieldset[aria-label="Diff to show"]');
    expect(parts?.textContent).toBe("Unstaged 2Staged 0");

    const stageButtons = [...container.querySelectorAll("button")].filter((item) => item.textContent === "Stage hunk");
    expect(stageButtons).toHaveLength(2);
    await act(async () => stageButtons[1]?.click());

    expect(commands).toContainEqual({
      type: "review.git.hunk",
      worktreeId: worktree.worktreeId,
      path: "src/app.ts",
      action: "stage",
      index: 1,
      hunk: "@@ -9,2 +9,3 @@ function nine() {\n nine\n+nine and a half\n ten",
    });
  });

  it("stashes with a message and confirms before dropping a stash", async () => {
    const stash = { index: 0, commit: "a".repeat(40), branch: "feature", message: "try the layout" };
    const { container, commands } = await render(
      undefined,
      (command) =>
        command.type === "review.git.stash"
          ? { stashes: [stash], created: true }
          : command.type === "review.git.stashAction"
            ? { stashes: [] }
            : gitReplies(command),
      changesReview(),
    );
    await act(async () => button(container, "Stashes (0)")?.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Stash message"]');
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "try the layout");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Stash changes")?.click());

    expect(commands).toContainEqual(expect.objectContaining({ type: "review.git.stash", message: "try the layout" }));
    expect(container.textContent).toContain("Stashes (1)");
    expect(container.textContent).toContain("Stashed the changes, untracked files included.");

    await act(async () => button(container, "Drop stash@{0}")?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Drop stash@{0}?");
    await act(async () => button(document, "Drop stash")?.click());
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "review.git.stashAction", action: "drop", index: 0, commit: stash.commit }),
    );
    expect(container.textContent).toContain("Stashes (0)");
  });
});
