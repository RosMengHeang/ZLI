import { describe, expect, it } from "vitest";

import {
  classifyTool,
  diffLineCounts,
  displayPath,
  editLines,
  patchLines,
  toolActivity,
  toolConnector,
} from "./toolActivity.js";

describe("classifyTool", () => {
  it.each([
    ["Bash", "command"],
    ["Execute", "command"],
    ["shell", "command"],
    ["run_terminal_cmd", "command"],
    ["commandExecution", "command"],
    ["Read", "file-read"],
    ["readToolCall", "file-read"],
    ["view", "file-read"],
    ["Edit", "file-edit"],
    ["MultiEdit", "file-edit"],
    ["Write", "file-edit"],
    ["ApplyPatch", "file-edit"],
    ["apply_patch", "file-edit"],
    ["Create", "file-edit"],
    ["str_replace_based_edit_tool", "file-edit"],
    ["fileChange", "file-edit"],
    ["Grep", "search"],
    ["Glob", "search"],
    ["LS", "search"],
    ["codebase_search", "search"],
    ["WebSearch", "web"],
    ["WebFetch", "web"],
    ["FetchUrl", "web"],
    ["TodoWrite", "tool"],
    ["Task", "tool"],
    ["github.search_issues", "search"],
    ["", "tool"],
  ])("classifies %s as %s", (name, kind) => {
    expect(classifyTool(name)).toBe(kind);
  });

  it("only treats generic read or edit names as file tools when they carry a path", () => {
    expect(classifyTool("notebook_read")).toBe("tool");
    expect(classifyTool("notebook_read", { path: "a.ipynb" })).toBe("file-read");
    expect(classifyTool("replace_in_file", { file_path: "a.ts" })).toBe("file-edit");
  });
});

describe("toolActivity", () => {
  const cwd = "/work/tree";

  it("titles commands with the first line of the command and keeps the output tail", () => {
    expect(
      toolActivity(
        {
          callId: "c1",
          name: "Bash",
          input: { command: "npm test\n# second line" },
          status: "failed",
          output: "1 failing\n",
        },
        cwd,
      ),
    ).toEqual({ activityId: "c1", kind: "command", title: "npm test", status: "failed", detail: "1 failing" });
    expect(
      toolActivity({
        callId: "c2",
        name: "commandExecution",
        input: { command: "bash -lc 'pnpm lint'" },
        status: "running",
      }),
    ).toMatchObject({ title: "pnpm lint" });
    expect(
      toolActivity({ callId: "c3", name: "exec", input: { command: ["git", "status"] }, status: "running" }),
    ).toMatchObject({
      title: "git status",
    });
    expect(toolActivity({ callId: "c4", name: "Execute", status: "running" })).toMatchObject({ title: "Execute" });
  });

  it("titles file reads and edits with cwd-relative paths and hides file contents on success", () => {
    expect(
      toolActivity(
        { callId: "r1", name: "Read", input: { file_path: "/work/tree/src/app.ts" }, status: "completed", output: "x" },
        cwd,
      ),
    ).toEqual({
      activityId: "r1",
      kind: "file-read",
      title: "Read src/app.ts",
      status: "completed",
      files: ["src/app.ts"],
    });
    expect(
      toolActivity(
        {
          callId: "e1",
          name: "ApplyPatch",
          input: {
            input: "*** Begin Patch\n*** Update File: /work/tree/a.ts\n*** Add File: /work/tree/b.ts\n*** End Patch",
          },
          status: "failed",
          output: "patch did not apply",
        },
        cwd,
      ),
    ).toEqual({
      activityId: "e1",
      kind: "file-edit",
      title: "Edit a.ts and 1 more",
      status: "failed",
      detail: "patch did not apply",
      files: ["a.ts", "b.ts"],
    });
    expect(
      toolActivity(
        { callId: "e2", name: "fileChange", input: { paths: ["/elsewhere/x.ts"] }, status: "completed" },
        cwd,
      ),
    ).toMatchObject({ title: "Edit /elsewhere/x.ts", files: ["/elsewhere/x.ts"] });
    expect(toolActivity({ callId: "e3", name: "Edit", status: "running" })).toMatchObject({ title: "Edit files" });
  });

  it("relativizes Windows paths case-insensitively", () => {
    expect(displayPath("C:\\Repo\\Tree\\src\\App.tsx", "c:\\repo\\tree")).toBe("src/App.tsx");
    expect(displayPath("D:\\other\\file.ts", "C:\\repo")).toBe("D:\\other\\file.ts");
    expect(displayPath("relative/file.ts", "C:\\repo")).toBe("relative/file.ts");
  });

  it("titles searches, listings, web calls, and other tools", () => {
    expect(
      toolActivity(
        { callId: "s1", name: "grep", input: { pattern: "TODO", path: "/work/tree" }, status: "running" },
        cwd,
      ),
    ).toMatchObject({ kind: "search", title: "Search TODO" });
    expect(
      toolActivity({ callId: "s2", name: "LS", input: { directory_path: "/work/tree/src" }, status: "running" }, cwd),
    ).toMatchObject({ kind: "search", title: "List src" });
    expect(
      toolActivity({ callId: "s3", name: "Glob", input: { patterns: ["*.ts", "*.tsx"] }, status: "running" }),
    ).toMatchObject({ title: "Search *.ts, *.tsx" });
    expect(
      toolActivity({ callId: "w1", name: "WebFetch", input: { url: "https://example.com" }, status: "running" }),
    ).toMatchObject({ kind: "web", title: "Fetch https://example.com" });
    expect(
      toolActivity({ callId: "w2", name: "webSearch", input: { query: "vitest" }, status: "running" }),
    ).toMatchObject({ kind: "web", title: "Web search vitest" });
    expect(
      toolActivity({ callId: "t1", name: "Task", input: { description: "Explore auth" }, status: "running" }),
    ).toMatchObject({ kind: "tool", title: "Task: Explore auth" });
  });

  it("caps long titles and output and never throws on odd input", () => {
    const activity = toolActivity({
      callId: "big",
      name: "shell",
      input: { command: "x".repeat(900) },
      status: "completed",
      output: `${"a".repeat(5_000)}END`,
    });
    expect(activity.title.length).toBeLessThanOrEqual(500);
    expect(activity.detail?.length).toBe(4_000);
    expect(activity.detail?.endsWith("END")).toBe(true);
    expect(() =>
      toolActivity({
        callId: "odd",
        name: "Read",
        input: { file_path: 42, paths: [null, { path: 7 }] },
        status: "running",
      }),
    ).not.toThrow();
    expect(toolActivity({ callId: "odd", name: "Read", input: { file_path: 42 }, status: "running" }).title).toBe(
      "Read file",
    );
  });
});

describe("edit line counts", () => {
  it("counts a replacement without the lines both sides share", () => {
    expect(
      toolActivity({
        callId: "e1",
        name: "Edit",
        input: { file_path: "a.ts", old_string: "one\ntwo\nthree", new_string: "one\n2\n2b\nthree" },
        status: "completed",
      }).lines,
    ).toEqual({ added: 2, removed: 1 });
    expect(
      editLines({
        edits: [
          { old_str: "a", new_str: "b" },
          { old_str: "c\nd", new_str: "" },
        ],
      }),
    ).toEqual({ added: 1, removed: 3 });
  });

  it("counts a new file, a patch, and prefers what the CLI reported", () => {
    expect(editLines({ path: "notes.md", fileText: "# Notes\n\nOne\n" })).toEqual({ added: 3, removed: 0 });
    const patch = ["*** Begin Patch", "*** Update File: a.ts", "@@", " keep", "-old", "+new", "+more", "*** End Patch"];
    expect(patchLines(patch.join("\n"))).toEqual({ added: 2, removed: 1 });
    expect(editLines({ input: patch.join("\n") })).toEqual({ added: 2, removed: 1 });
    expect(diffLineCounts("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
    const reported = toolActivity({
      callId: "e2",
      name: "edit",
      input: { path: "a.ts", streamContent: "x" },
      status: "completed",
      lines: { added: 7, removed: 2 },
    });
    expect(reported.lines).toEqual({ added: 7, removed: 2 });
    expect(
      toolActivity({
        callId: "e3",
        name: "Edit",
        input: { file_path: "a.ts", old_string: "a", new_string: "b" },
        status: "failed",
      }).lines,
    ).toBeUndefined();
  });

  it("titles a command by its description and keeps the command line", () => {
    expect(
      toolActivity({
        callId: "c1",
        name: "Bash",
        input: { command: "pnpm -r typecheck", description: "Typecheck web" },
        status: "running",
      }),
    ).toMatchObject({ kind: "command", title: "Typecheck web", command: "pnpm -r typecheck" });
    expect(
      toolActivity({ callId: "c2", name: "Bash", input: { command: "ls" }, status: "running" }),
    ).not.toHaveProperty("command");
  });
});

describe("toolConnector", () => {
  const signIn =
    "MCP error -32001: my-linear needs you to sign in. Open ZLI Settings, then Connectors or MCP servers, and sign in again.";

  it("finds the server that needs a sign-in in a failed call's error", () => {
    const activity = toolActivity({
      callId: "m1",
      name: "mcp__my-linear__list_issues",
      status: "failed",
      output: signIn,
    });
    expect(activity.connector).toEqual({ server: "my-linear", reason: "sign-in" });
    expect(activity.detail).toBe(signIn);
    expect(toolConnector({ callId: "m2", name: "linear.list_issues", status: "completed", output: signIn })).toBe(
      undefined,
    );
    expect(toolConnector({ callId: "m3", name: "Bash", status: "failed", output: "exit 1" })).toBe(undefined);
  });

  it("keeps the service an agent asks to connect, as its catalog id when it has one", () => {
    expect(
      toolActivity({
        callId: "r1",
        name: "mcp__zli__connect_service",
        input: { service: "GitHub" },
        status: "running",
      }),
    ).toMatchObject({ title: "Ask to connect GitHub", connector: { server: "github", reason: "request" } });
    expect(
      toolConnector({ callId: "r2", name: "zli.connect_service", input: { service: "my-db" }, status: "completed" }),
    ).toEqual({ server: "my-db", reason: "request" });
    expect(
      toolConnector({ callId: "r3", name: "connect_service", input: { service: "linear" }, status: "failed" }),
    ).toBe(undefined);
    expect(
      toolConnector({
        callId: "r4",
        name: "mcp__other__connect_service",
        input: { service: "x" },
        status: "completed",
      }),
    ).toBe(undefined);
  });
});
