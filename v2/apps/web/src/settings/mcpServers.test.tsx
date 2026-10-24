// @vitest-environment jsdom

import { CommandId, type McpServerConfig } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { McpServersSection } from "./McpServersSection.js";
import { applyDraft, commandLine, EMPTY_DRAFT, envFromText, settingsProblems } from "./mcpServers.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const github: McpServerConfig = {
  name: "github",
  enabled: true,
  command: "npx",
  args: ["-y", "gh-mcp"],
  env: { TOKEN: "t" },
};

describe("MCP server drafts", () => {
  it("reads one argument per line and NAME=value environment lines", () => {
    const applied = applyDraft(
      [],
      { ...EMPTY_DRAFT, name: " linear ", command: " linear-mcp ", args: "--port\n\n 8080 ", env: "A=1\nB=x=y\n" },
      undefined,
    );
    expect(applied).toEqual({
      servers: [
        { name: "linear", enabled: true, command: "linear-mcp", args: ["--port", "8080"], env: { A: "1", B: "x=y" } },
      ],
    });
    expect(envFromText("TOKEN")).toEqual({ problem: "Environment line 1 needs the form NAME=value." });
  });

  it("explains what blocks a save", () => {
    expect(applyDraft([], { ...EMPTY_DRAFT, command: "x" }, undefined)).toEqual({ problem: "Add a name." });
    expect(applyDraft([github], { ...EMPTY_DRAFT, name: "GitHub", command: "x" }, undefined)).toEqual({
      problem: "GitHub is listed twice.",
    });
    expect(applyDraft([github], { ...EMPTY_DRAFT, name: "github", command: "uvx" }, 0)).toMatchObject({
      servers: [{ name: "github", command: "uvx" }],
    });
    expect(applyDraft([], { ...EMPTY_DRAFT, name: "zli-browser", command: "x" }, undefined)).toEqual({
      problem: "This name is used by ZLI.",
    });
    expect(applyDraft([], { ...EMPTY_DRAFT, name: "a", command: "x", env: "1BAD=x" }, undefined)).toEqual({
      problem: "Environment line 1: names use letters, digits, and _, and do not start with a digit.",
    });
  });

  it("summarizes the command and the settings files ZLI could not change", () => {
    expect(commandLine({ command: "C:\\Program Files\\node.exe", args: ["server.js"] })).toBe(
      '"C:\\Program Files\\node.exe" server.js',
    );
    expect(
      settingsProblems([
        {
          provider: "gemini",
          path: "C:\\home\\.gemini\\settings.json",
          status: "skipped-invalid",
          message: "The file is not plain JSON.",
        },
        { provider: "droid", path: "C:\\home\\.factory\\mcp.json", status: "updated" },
      ]),
    ).toEqual(["Gemini: C:\\home\\.gemini\\settings.json. The file is not plain JSON. ZLI left it unchanged."]);
  });
});

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}

describe("McpServersSection", () => {
  it("adds, turns off, and removes servers through the runtime", async () => {
    let servers: McpServerConfig[] = [];
    let agentAccess = "full";
    const saves: McpServerConfig[][] = [];
    const bridge = {
      runtime: {
        dispatch: async (request: {
          commandId: string;
          command: { type: string; servers?: McpServerConfig[]; access?: string };
        }) => {
          if (request.command.type === "mcp.save") {
            servers = request.command.servers ?? [];
            saves.push(servers);
          }
          if (request.command.type === "mcp.agentAccess") agentAccess = request.command.access ?? agentAccess;
          return {
            commandId: CommandId.parse(request.commandId),
            accepted: true as const,
            result: { servers, agentAccess, userSettings: { enabled: true, outcomes: [] } },
          };
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge}>
          <McpServersSection />
        </RuntimeProvider>,
      );
    });
    expect(container.textContent).toContain("No servers yet.");
    const access = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="What agents may do with other agents"]',
    ) as HTMLButtonElement;
    expect(access.getAttribute("aria-label")).toBe("What agents may do with other agents: Start and message agents");
    await act(async () => access.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="option"][data-label="List and read agents"]')?.click(),
    );
    expect(agentAccess).toBe("read");
    expect(access.getAttribute("aria-label")).toBe("What agents may do with other agents: List and read agents");

    await act(async () => button(container, "Add server").click());
    const form = container.querySelector("form") as HTMLFormElement;
    const [name, command] = [...form.querySelectorAll("input")] as HTMLInputElement[];
    const [args, env] = [...form.querySelectorAll("textarea")] as HTMLTextAreaElement[];
    await act(async () => {
      setValue(name as HTMLInputElement, "github");
      setValue(command as HTMLInputElement, "npx");
      setValue(args as HTMLTextAreaElement, "-y\ngh-mcp");
      setValue(env as HTMLTextAreaElement, "TOKEN=t");
    });
    await act(async () => form.requestSubmit());
    expect(saves).toEqual([[github]]);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector(".mcp-row-command")?.textContent).toBe("npx -y gh-mcp");

    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]') as HTMLInputElement;
    await act(async () => toggle.click());
    expect(saves.at(-1)).toEqual([{ ...github, enabled: false }]);

    await act(async () => button(container, "Remove github").click());
    await act(async () => button(container, "Remove").click());
    expect(saves.at(-1)).toEqual([]);
    expect(container.textContent).toContain("No servers yet.");
  });

  it("shows why the list could not load and retries", async () => {
    let calls = 0;
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string }) => {
          calls += 1;
          return calls === 1
            ? {
                commandId: CommandId.parse(request.commandId),
                accepted: false as const,
                error: { code: "unavailable", message: "MCP servers are not available here.", retryable: false },
              }
            : {
                commandId: CommandId.parse(request.commandId),
                accepted: true as const,
                result: { servers: [github], agentAccess: "full", userSettings: { enabled: false, outcomes: [] } },
              };
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge}>
          <McpServersSection />
        </RuntimeProvider>,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("MCP servers are not available here.");
    await act(async () => button(container, "Try again").click());
    expect([...container.querySelectorAll(".mcp-row strong")].map((node) => node.textContent)).toEqual([
      "zli",
      "zli-browser",
      "github",
    ]);
    expect(container.textContent).toContain("ZLI is set to leave those files alone");
  });
});
