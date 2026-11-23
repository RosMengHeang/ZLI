import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type RpcResponse,
  type RuntimeProjection,
  type ThreadProjection,
  WorktreeId,
} from "@zli-v2/contracts";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileIndexProvider } from "../files/FileIndex.js";
import type { SavedPrompt } from "../prompts/prompts.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import type { Buddy } from "../teammates/buddies.js";
import { Composer } from "./Composer.js";
import { resetComposerSkillCache, useComposerMenu } from "./ComposerMenu.js";
import type { ComposerCommand, MentionOption } from "./composerTriggers.js";
import { resetContextSourceCache } from "./contextSources.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");

const projection: RuntimeProjection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: {},
  },
  projects: [{ projectId, path: "C:/repo", name: "repo" }],
  worktrees: [{ worktreeId, projectId, path: "C:/repo", branch: "main", status: "ready" }],
  threads: [],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 1,
};

const files = [{ path: "README.md" }, { path: "src/app.ts" }, { path: "src/chat/Composer.tsx", status: "modified" }];
const skills = {
  skills: [{ name: "review", description: "Review a diff", scope: "user", enabled: true, path: "/s/review" }],
  found: [],
  libraryPath: "/s",
  sync: { enabled: true, outcomes: [] },
};

let root: Root | undefined;
let requests: string[] = [];

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  requests = [];
  resetComposerSkillCache();
  resetContextSourceCache();
  document.body.replaceChildren();
});

const otherThread = {
  threadId: "00000000-0000-4000-8000-000000000402",
  sessionId: "00000000-0000-4000-8000-000000000702",
  worktreeId,
  provider: "codex",
  status: "idle",
  capabilities: {},
  permissionMode: "supervised",
} as unknown as ThreadProjection;
const ownThread = {
  ...otherThread,
  threadId: "00000000-0000-4000-8000-000000000401",
  sessionId: "00000000-0000-4000-8000-000000000701",
} as ThreadProjection;
const terminalId = "00000000-0000-4000-8000-000000000601";

/** A project with another chat, a terminal, and a browser page, for "#". */
const busy: RuntimeProjection = {
  ...projection,
  threads: [ownThread, otherThread],
  messages: [
    { messageId: "m1", threadId: ownThread.threadId, role: "user", text: "This chat" },
    { messageId: "m2", threadId: otherThread.threadId, role: "user", text: "Fix the login page" },
    { messageId: "m3", threadId: otherThread.threadId, role: "assistant", text: "Fixed in auth.ts" },
  ],
  terminals: [{ terminalId, worktreeId, title: "npm test", status: "exited", lastSequence: 3, kind: "shell" }],
  browserTabs: [
    {
      browserTabId: "00000000-0000-4000-8000-000000000801",
      profileId: "00000000-0000-4000-8000-000000000901",
      worktreeId,
      url: "http://localhost:5173/login",
      title: "Login",
      active: true,
      status: "idle",
    },
  ],
} as unknown as RuntimeProjection;

function bridge(source: RuntimeProjection = projection): ZliBridge {
  return {
    runtime: {
      getProjection: async () => source,
      onProjection: () => () => undefined,
      dispatch: async (request: { command: { type: string } }): Promise<RpcResponse> => {
        requests.push(request.command.type);
        const result =
          request.command.type === "files.list"
            ? { files, truncated: false }
            : request.command.type === "skills.list"
              ? skills
              : request.command.type === "terminal.read"
                ? { terminalId, text: "PASS a\nFAIL b\n", truncated: false }
                : request.command.type === "files.diff"
                  ? { path: "src/chat/Composer.tsx", binary: false, patch: "+one line", truncated: false }
                  : request.command.type === "review.git.branches"
                    ? { current: "main", local: ["main"], remote: [] }
                    : {};
        return { commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true, result };
      },
    },
  } as unknown as ZliBridge;
}

const owl: MentionOption = { name: "Owl", buddy: "sky" as Buddy, provider: "codex", detail: "Codex · in this chat" };
const prompts: SavedPrompt[] = [
  { key: "p1", name: "Write tests", prompt: "Write tests for this.", source: "personal" },
];

function Harness({ commands }: { commands: ComposerCommand[] }) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menu = useComposerMenu({
    draft,
    setDraft,
    textareaRef,
    mentions: [owl],
    worktreeId,
    projectId,
    provider: "claude-code",
    agentName: "Claude Code",
    commands,
    prompts,
  });
  return (
    <div>
      {menu.list}
      <textarea
        ref={textareaRef}
        aria-label="Message"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          menu.trackCaret(event);
        }}
        onSelect={menu.trackCaret}
        {...menu.inputProps}
        onKeyDown={(event) => {
          menu.onKeyDown(event);
        }}
      />
    </div>
  );
}

async function render(commands: ComposerCommand[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge()}>
        <FileIndexProvider onOpenFile={() => undefined}>
          <Harness commands={commands} />
        </FileIndexProvider>
      </RuntimeProvider>,
    );
  });
  return container;
}

const box = () => document.querySelector<HTMLTextAreaElement>("textarea") as HTMLTextAreaElement;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent);

async function type(value: string) {
  const textarea = box();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("useComposerMenu", () => {
  it("lists teammates and worktree files for @, and inserts the picked path", async () => {
    await render();
    await type("look at @");
    await vi.waitFor(() => expect(options()).toHaveLength(4));
    expect(listbox()?.getAttribute("aria-label")).toBe("Files, teammates, and buddies");
    expect(listbox()?.textContent).toContain("Teammates");
    expect(options()[0]).toContain("Owl");
    // Changed files come first.
    expect(options()[1]).toContain("Composer.tsx");

    await type("look at @app");
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("app.ts");
    await press("Enter");
    expect(box().value).toBe("look at @src/app.ts ");
    expect(listbox()).toBeNull();
    expect(requests).toContain("files.list");
  });

  it("moves with the arrows, points aria-activedescendant at the row, and closes on Escape", async () => {
    await render();
    await type("@");
    await vi.waitFor(() => expect(options()).toHaveLength(4));
    const active = () => document.getElementById(box().getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(active()).toContain("Owl");
    await press("ArrowDown");
    expect(active()).toContain("Composer.tsx");
    await press("ArrowUp");
    await press("ArrowUp");
    expect(active()).toContain("app.ts");
    await press("Escape");
    expect(listbox()).toBeNull();
    expect(box().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("calls a teammate the same way @ always did", async () => {
    await render();
    await type("@o");
    await vi.waitFor(() => expect(options()[0]).toContain("Owl"));
    await press("Tab");
    expect(box().value).toBe("@Owl ");
  });

  it("closes when a space ends the word", async () => {
    await render();
    await type("@src");
    await vi.waitFor(() => expect(listbox()).not.toBeNull());
    await type("@src ");
    expect(listbox()).toBeNull();
  });

  it("lists skills for $ and inserts $name", async () => {
    await render();
    await type("please $re");
    await vi.waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]).toContain("review");
    expect(options()[0]).toContain("Review a diff");
    document.querySelector<HTMLElement>('[role="option"]')?.click();
    await act(async () => undefined);
    expect(box().value).toBe("please $review ");
    expect(requests).toContain("skills.list");
  });

  it("stays shut for money", async () => {
    await render();
    await type("it costs $5");
    expect(listbox()).toBeNull();
    expect(requests).not.toContain("skills.list");
  });

  it("lists commands and saved prompts for / at the start, and runs or inserts the pick", async () => {
    const newChat = vi.fn();
    await render([
      { name: "new", description: "Start a new chat", run: newChat, source: "zli" },
      { name: "compact", description: "Summarize the conversation", insert: "/compact", source: "agent" },
    ]);
    await type("/");
    expect(listbox()?.textContent).toContain("Commands");
    expect(listbox()?.textContent).toContain("Claude Code commands");
    expect(listbox()?.textContent).toContain("Saved prompts");
    expect(options()).toEqual([
      expect.stringContaining("/new"),
      expect.stringContaining("/compact"),
      expect.stringContaining("Write tests"),
    ]);

    await type("/comp");
    await press("Enter");
    expect(box().value).toBe("/compact ");

    await type("/ne");
    await press("Enter");
    expect(newChat).toHaveBeenCalledTimes(1);
    expect(box().value).toBe("");

    await type("/write");
    await press("Enter");
    expect(box().value).toBe("Write tests for this.");
  });

  it("does not open commands in the middle of a message", async () => {
    await render([{ name: "new", description: "Start a new chat", run: () => undefined }]);
    await type("see /new");
    expect(listbox()).toBeNull();
  });
});

describe("Composer with the menu", () => {
  it("names the triggers in the placeholder and asks for a mentioned skill when sending", async () => {
    const onSubmit = vi.fn(async () => true);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RuntimeProvider bridge={bridge()}>
          <FileIndexProvider onOpenFile={() => undefined}>
            <Composer
              displayName="Claude Code"
              provider="claude-code"
              branch="main"
              workspace={<span />}
              worktreeId={worktreeId}
              disabled={false}
              models={undefined}
              model={undefined}
              modelLocked={false}
              onModelChange={() => undefined}
              permissionMode="supervised"
              projectId={projectId}
              onSubmit={onSubmit}
            />
          </FileIndexProvider>
        </RuntimeProvider>,
      );
    });
    expect(box().placeholder).toBe("Ask Claude Code anything. @ files, # context, $ skills, / commands");

    await type("$review the diff");
    await vi.waitFor(() => expect(requests).toContain("skills.list"));
    await act(async () => undefined);
    await press("Enter");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      '$review the diff\n\n<zli-context kind="mentions">\nUse the review skill.\n</zli-context>',
      [],
    );
  });
});

const reviewer: MentionOption = {
  name: "Reviewer",
  buddy: "sky" as Buddy,
  provider: "",
  detail: "Code review · gets this as a job",
  kind: "buddy",
};

async function renderComposer(onSubmit: (text: string) => Promise<boolean>, source: RuntimeProjection = busy) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge(source)}>
        <FileIndexProvider onOpenFile={() => undefined}>
          <Composer
            displayName="Claude Code"
            provider="claude-code"
            branch="main"
            workspace={<span />}
            worktreeId={worktreeId}
            mentions={[owl, reviewer]}
            disabled={false}
            models={undefined}
            model={undefined}
            modelLocked={false}
            onModelChange={() => undefined}
            permissionMode="supervised"
            projectId={projectId}
            draftKey={ownThread.sessionId}
            onSubmit={onSubmit}
          />
        </FileIndexProvider>
      </RuntimeProvider>,
    );
  });
  return container;
}

const chipLabels = () =>
  [...document.querySelectorAll<HTMLElement>(".composer-chip-label")].map((chip) => chip.textContent);

describe("# in the message box", () => {
  it("lists the diff, other chats, branches, terminals, and the browser page, in groups", async () => {
    await renderComposer(async () => true);
    await type("#");
    await vi.waitFor(() => expect(options()).toHaveLength(5));
    expect(listbox()?.getAttribute("aria-label")).toBe("Chats, pull requests, and changes");
    expect(options()).toEqual([
      expect.stringContaining("Uncommitted changes"),
      expect.stringContaining("Fix the login page"),
      expect.stringContaining("main"),
      expect.stringContaining("npm test"),
      expect.stringContaining("Login"),
    ]);
    // This chat is not offered to itself.
    expect(listbox()?.textContent).not.toContain("This chat");
    for (const group of ["Changes", "Chats", "Branches", "Terminals", "Browser"])
      expect(listbox()?.textContent).toContain(group);
  });

  it("turns a pick into a chip and sends the terminal's last lines with the message", async () => {
    const onSubmit = vi.fn(async (_text: string) => true);
    await renderComposer(onSubmit);
    await type("#npm");
    await vi.waitFor(() => expect(options()).toHaveLength(1));
    await press("Enter");
    expect(chipLabels()).toEqual(["npm test"]);
    expect(box().value).toBe("");
    await type("why did it fail");
    await press("Enter");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toBe(
      'why did it fail\n\n<zli-context kind="terminal" label="npm test · last 80 lines">\n### Context: terminal "npm test", last 80 lines\n\n```\nPASS a\nFAIL b\n```\n</zli-context>',
    );
    expect(requests).toContain("terminal.read");
    await vi.waitFor(() => expect(chipLabels()).toEqual([]));
  });

  it("sends a short transcript of another chat and the browser page", async () => {
    const onSubmit = vi.fn(async (_text: string) => true);
    await renderComposer(onSubmit);
    await type("#login p");
    await type("#fix");
    await vi.waitFor(() => expect(options()[0]).toContain("Fix the login page"));
    await press("Enter");
    await type("#localhost");
    await vi.waitFor(() => expect(options()[0]).toContain("Login"));
    await press("Enter");
    expect(chipLabels()).toEqual(["Fix the login page", "Login"]);
    await press("Enter");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toBe(
      [
        '<zli-context kind="chat" label="Chat · Fix the login page">\n### Context: the chat "Fix the login page"',
        "User: Fix the login page\n\nAgent: Fixed in auth.ts\n</zli-context>",
        `<zli-context kind="browser" label="Page · Login">\n### Context: the page open in ZLI's browser`,
        "Title: Login\nURL: http://localhost:5173/login\n</zli-context>",
      ].join("\n\n"),
    );
  });
});

describe("chips in the message box", () => {
  it("removes the last chip with Backspace at the start of the text, and with its x", async () => {
    await renderComposer(async () => true);
    await type("@app");
    await vi.waitFor(() => expect(options()[0]).toContain("app.ts"));
    await press("Enter");
    // The pick puts the caret back in the box on the next frame; let it land before typing again.
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(chipLabels()).toEqual(["app.ts"]);
    await type("#npm");
    await vi.waitFor(() => expect(options()).toHaveLength(1));
    await press("Enter");
    expect(chipLabels()).toEqual(["app.ts", "npm test"]);
    await press("Backspace");
    expect(chipLabels()).toEqual(["app.ts"]);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove app.ts"]')?.click());
    expect(chipLabels()).toEqual([]);
  });

  it("keeps Backspace for the text when the caret is not at its start", async () => {
    await renderComposer(async () => true);
    await type("#npm");
    await vi.waitFor(() => expect(options()).toHaveLength(1));
    await press("Enter");
    await type("hi");
    await press("Backspace");
    expect(chipLabels()).toEqual(["npm test"]);
  });

  it("lists buddies in their own group, found by name or by what they do", async () => {
    await renderComposer(async () => true);
    await type("@");
    await vi.waitFor(() => expect(listbox()?.textContent).toContain("Buddies"));
    expect(options().slice(0, 2)).toEqual([expect.stringContaining("Owl"), expect.stringContaining("Reviewer")]);
    await type("@code");
    await vi.waitFor(() => expect(options()[0]).toContain("Reviewer"));
  });

  it("sends a picked buddy as @Name at the start, where the chat routes it to that buddy", async () => {
    const onSubmit = vi.fn(async (_text: string) => true);
    await renderComposer(onSubmit);
    await type("check this @rev");
    await vi.waitFor(() => expect(options()[0]).toContain("Reviewer"));
    await press("Enter");
    expect(chipLabels()).toEqual(["Reviewer"]);
    expect(box().value).toBe("check this ");
    await press("Enter");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toBe("@Reviewer check this");
  });

  it("keeps the chips when sending fails", async () => {
    await renderComposer(async () => false);
    await type("#npm");
    await vi.waitFor(() => expect(options()).toHaveLength(1));
    await press("Enter");
    await type("go");
    await press("Enter");
    await act(async () => undefined);
    expect(chipLabels()).toEqual(["npm test"]);
  });
});
