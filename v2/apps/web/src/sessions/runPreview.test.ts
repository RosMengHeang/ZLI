// @vitest-environment jsdom

import type { DevServerProjection, RpcResponse, TerminalProjection } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  detectDevCommand,
  devCommandFromPackage,
  previewState,
  previewTerminalCommand,
  savedPreviewCommand,
  savePreviewCommand,
} from "./runPreview.js";

const worktreeId = "00000000-0000-4000-8000-000000000101";

afterEach(() => localStorage.clear());

describe("devCommandFromPackage", () => {
  it("installs first, then runs the first dev-like script with the named package manager", () => {
    expect(devCommandFromPackage(JSON.stringify({ scripts: { start: "node .", dev: "vite" } }))).toBe(
      "npm install && npm run dev",
    );
    expect(devCommandFromPackage(JSON.stringify({ scripts: { start: "next start" } }), "pnpm")).toBe(
      "pnpm install && pnpm run start",
    );
    expect(devCommandFromPackage(JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { dev: "vite" } }))).toBe(
      "yarn install && yarn run dev",
    );
  });

  it("finds nothing without a dev-like script or valid JSON", () => {
    expect(devCommandFromPackage(JSON.stringify({ scripts: { build: "tsc" } }))).toBeUndefined();
    expect(devCommandFromPackage("{")).toBeUndefined();
    expect(devCommandFromPackage("[]")).toBeUndefined();
  });
});

describe("detectDevCommand", () => {
  const file = (path: string, content?: string) => ({
    path,
    size: content?.length ?? 0,
    version: "v",
    ...(content === undefined ? {} : { content }),
    binary: false,
    tooLarge: false,
    bom: false,
    lineEnding: "lf",
  });

  it("reads package.json and picks the package manager from the lockfile there", async () => {
    const asked: string[] = [];
    const dispatch = async (request: unknown): Promise<RpcResponse> => {
      const command = (request as { command: { path: string } }).command;
      asked.push(command.path);
      const found =
        command.path === "package.json"
          ? file("package.json", JSON.stringify({ scripts: { dev: "vite" } }))
          : command.path === "yarn.lock"
            ? file("yarn.lock")
            : undefined;
      return found
        ? ({ commandId: "c", accepted: true, result: found } as unknown as RpcResponse)
        : ({
            commandId: "c",
            accepted: false,
            error: { code: "invalid_request", message: "missing", retryable: false },
          } as unknown as RpcResponse);
    };
    expect(await detectDevCommand(dispatch, worktreeId)).toBe("yarn install && yarn run dev");
    expect(asked).toEqual(["package.json", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock"]);
  });

  it("finds nothing when the worktree has no package.json", async () => {
    const dispatch = async (): Promise<RpcResponse> =>
      ({
        commandId: "c",
        accepted: false,
        error: { code: "invalid_request", message: "missing", retryable: false },
      }) as unknown as RpcResponse;
    expect(await detectDevCommand(dispatch, worktreeId)).toBeUndefined();
  });
});

describe("saved preview commands", () => {
  it("remembers one command per project and forgets it when cleared", () => {
    savePreviewCommand("p1", "  pnpm dev  ");
    expect(savedPreviewCommand("p1")).toBe("pnpm dev");
    expect(savedPreviewCommand("p2")).toBeUndefined();
    savePreviewCommand("p1", "");
    expect(savedPreviewCommand("p1")).toBeUndefined();
  });
});

describe("previewTerminalCommand", () => {
  it("runs the command in the run's worktree, titled after the run", () => {
    const worktree = { worktreeId, path: "/repo-run2" };
    expect(previewTerminalCommand("pnpm dev", worktree, "Preview, run 2", false)).toMatchObject({
      type: "terminal.create",
      worktreeId,
      cwd: "/repo-run2",
      title: "Preview, run 2",
      shell: "/bin/bash",
      args: ["-lc", "pnpm dev"],
    });
    expect(previewTerminalCommand("pnpm dev", worktree, "Preview, run 2", true)).toMatchObject({
      shell: "cmd.exe",
      args: ["/d", "/s", "/c", '"pnpm dev"'],
    });
  });
});

describe("previewState", () => {
  const server = (worktree: string, terminalId: string, port: number) =>
    ({ worktreeId: worktree, terminalId, port, url: `http://localhost:${port}/` }) as DevServerProjection;
  const terminal = (terminalId: string, status: TerminalProjection["status"]) =>
    ({ terminalId, status }) as TerminalProjection;

  it("is ready with the run's own server, or any server already running in its worktree", () => {
    const servers = [server(worktreeId, "other", 3000), server(worktreeId, "mine", 5174), server("w2", "x", 9000)];
    expect(previewState(servers, [], worktreeId, "mine")).toEqual({ kind: "ready", url: "http://localhost:5174/" });
    expect(previewState(servers.slice(0, 1), [], worktreeId, undefined)).toEqual({
      kind: "ready",
      url: "http://localhost:3000/",
    });
  });

  it("is starting until an address shows, and failed when the terminal exits first", () => {
    expect(previewState([], [terminal("mine", "running")], worktreeId, "mine")).toEqual({ kind: "starting" });
    expect(previewState([], [], worktreeId, "mine")).toEqual({ kind: "starting" });
    expect(previewState([], [terminal("mine", "exited")], worktreeId, "mine")).toMatchObject({ kind: "failed" });
    expect(previewState([], [], worktreeId, undefined)).toEqual({ kind: "idle" });
  });
});
