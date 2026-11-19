// @vitest-environment jsdom

import { CommandId, installCommand } from "@zli-v2/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentUnavailableNotice } from "../chat/AgentUnavailableNotice.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { AgentInstallContext, InstallAgentButton, installTerminalCommand, type RunInstall } from "./InstallAgent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktreeId = "00000000-0000-4000-8000-000000000011";
const sessionId = "00000000-0000-4000-8000-000000000012";

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function render(node: ReactNode) {
  const commands: Record<string, unknown>[] = [];
  const openExternal = vi.fn(async () => undefined);
  const bridge = {
    app: { openExternal },
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        commands.push(request.command);
        return { commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true as const };
      },
      getProjection: async () => undefined,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  // The shell's runner, cut down: it opens the terminal through the bridge.
  const run: RunInstall = async (_provider, command) => {
    await bridge.runtime.dispatch({
      protocolVersion: 1,
      commandId: "00000000-0000-4000-8000-000000000098",
      command: installTerminalCommand({ command, title: "Install", worktreeId, cwd: "C:/repo", sessionId }),
    } as never);
    return undefined;
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <AgentInstallContext.Provider value={run}>{node}</AgentInstallContext.Provider>
      </RuntimeProvider>,
    );
  });
  return { container, commands, openExternal };
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((entry) => entry.textContent === name);
  if (!found) throw new Error(`No ${name} button`);
  return found;
}

describe("installing a missing agent", () => {
  it("asks first with the exact command, then opens a terminal that runs it", async () => {
    const { commands } = await render(<InstallAgentButton provider="codex" name="Codex" />);
    expect(commands).toEqual([]);
    await act(async () => button("Install").click());
    const shown = document.querySelector(".install-agent-command")?.textContent;
    expect(shown).toBe("npm install -g @openai/codex");
    expect(commands).toEqual([]);
    await act(async () => button("Run install").click());
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "terminal.create", worktreeId, sessionId });
    expect(commands[0]?.args).toContain("npm install -g @openai/codex");
    expect(document.querySelector(".install-agent-command")).toBeNull();
  });

  it("runs nothing when the person cancels", async () => {
    const { commands } = await render(<InstallAgentButton provider="gemini" name="Gemini" />);
    await act(async () => button("Install").click());
    await act(async () => button("Cancel").click());
    expect(commands).toEqual([]);
  });

  it("links to the install page for agents without one command", async () => {
    const { openExternal } = await render(<InstallAgentButton provider="goose" name="Goose" />);
    expect(() => button("Install")).toThrow();
    await act(async () => button("Open install page").click());
    expect(openExternal).toHaveBeenCalledWith("https://github.com/aaif-goose/goose");
  });

  it("shows the button on the chat notice for an agent that is not installed", async () => {
    await render(<AgentUnavailableNotice name="Claude Code" provider="claude-code" status={{ kind: "missing" }} />);
    expect(button("Install")).toBeTruthy();
  });

  it("uses PowerShell on Windows and a login shell elsewhere", () => {
    const command = installCommand("claude-code", "windows") ?? "";
    const input = { command, title: "Install", worktreeId, cwd: "C:/repo", sessionId };
    expect(installTerminalCommand(input, true)).toMatchObject({ shell: "powershell.exe" });
    expect(installTerminalCommand(input, true).args.at(-1)).toBe(command);
    expect(installTerminalCommand(input, false)).toMatchObject({ shell: "/bin/bash", args: ["-lc", command] });
  });
});
