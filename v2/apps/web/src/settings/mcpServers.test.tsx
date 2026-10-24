// @vitest-environment jsdom

import { CommandId, type McpServerConfig } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { McpServersSection } from "./McpServersSection.js";
import {
  applyDraft,
  commandLine,
  draftFromServer,
  EMPTY_DRAFT,
  envFromText,
  headersFromText,
  serverSummary,
  settingsProblems,
} from "./mcpServers.js";

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

  it("builds remote servers from the URL, header lines, and sign-in choice", () => {
    const draft = {
      ...EMPTY_DRAFT,
      name: "linear",
      transport: "http" as const,
      command: "ignored",
      url: " https://mcp.linear.app/mcp ",
      headers: "Authorization: Bearer lin_1\n\nX-Team:eng",
      oauth: true,
    };
    const linear = {
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer lin_1", "X-Team": "eng" },
      oauth: true,
    };
    expect(applyDraft([github], draft, undefined)).toEqual({ servers: [github, linear] });
    expect(draftFromServer(linear as McpServerConfig)).toMatchObject({
      transport: "http",
      url: linear.url,
      headers: "Authorization: Bearer lin_1\nX-Team: eng",
      oauth: true,
    });
    expect(applyDraft([], { ...draft, url: "http://mcp.example.com" }, undefined)).toEqual({
      problem: "Use https://. Plain http:// works only for servers on this computer (localhost).",
    });
    expect(applyDraft([], { ...draft, url: "" }, undefined)).toEqual({ problem: "Add the server address." });
    expect(headersFromText("Bearer x")).toEqual({ problem: "Header line 1 needs the form Name: value." });
    expect(headersFromText("Bad Name: x")).toEqual({
      problem: "Header line 1: names use letters, digits, and - only.",
    });
  });

  it("shows header names but never their values in the row summary", () => {
    const summary = serverSummary({
      name: "ctx",
      enabled: true,
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer secret-token" },
      oauth: true,
    });
    expect(summary).toBe("https://mcp.context7.com/mcp · Authorization: •••• · sign in with browser");
    expect(summary).not.toContain("secret-token");
    expect(serverSummary(github)).toBe("npx -y gh-mcp");
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

  it("adds a remote server and catalog servers", async () => {
    let servers: McpServerConfig[] = [];
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string; command: { type: string; servers?: McpServerConfig[] } }) => {
          if (request.command.type === "mcp.save") servers = request.command.servers ?? [];
          return {
            commandId: CommandId.parse(request.commandId),
            accepted: true as const,
            result: { servers, agentAccess: "full", userSettings: { enabled: true, outcomes: [] } },
          };
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
      app: { getVersion: async () => "0", quit: async () => undefined },
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

    await act(async () => button(container, "Add server").click());
    let form = container.querySelector("form") as HTMLFormElement;
    await act(async () => setValue(form.querySelector("input") as HTMLInputElement, "context7"));
    await act(async () => form.querySelector<HTMLButtonElement>('button[aria-label="Type: Local process"]')?.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="option"][data-label="Remote server"]')?.click(),
    );
    form = container.querySelector("form") as HTMLFormElement;
    const url = form.querySelector<HTMLInputElement>('input[inputmode="url"]') as HTMLInputElement;
    const headers = form.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setValue(url, "https://mcp.context7.com/mcp");
      setValue(headers, "Authorization: Bearer ctx-secret");
    });
    await act(async () => form.requestSubmit());
    expect(servers).toEqual([
      {
        name: "context7",
        enabled: true,
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        headers: { Authorization: "Bearer ctx-secret" },
        oauth: false,
      },
    ]);
    expect(container.querySelector(".mcp-row-command")?.textContent).toBe(
      "https://mcp.context7.com/mcp · Authorization: ••••",
    );
    expect(container.textContent).not.toContain("ctx-secret");

    await act(async () => button(container, "Browse catalog").click());
    const catalog = container.querySelector('[aria-label="MCP server catalog"]') as HTMLElement;
    expect(catalog.querySelector('[data-entry="context7"]')?.textContent).toContain("Added");
    const search = catalog.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    await act(async () => setValue(search, "linear"));
    expect([...catalog.querySelectorAll(".mcp-catalog-item")].map((item) => item.getAttribute("data-entry"))).toEqual([
      "linear",
    ]);
    await act(async () => button(catalog, "Add Linear").click());
    expect(servers.at(-1)).toEqual({
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {},
      oauth: true,
    });
    expect(catalog.querySelector('[data-entry="linear"]')?.textContent).toContain("Added");

    await act(async () => setValue(search, "github"));
    await act(async () => button(catalog, "Add GitHub").click());
    const githubForm = catalog.querySelector('form[aria-label="Add GitHub"]') as HTMLFormElement;
    await act(async () => githubForm.requestSubmit());
    expect(githubForm.textContent).toContain("Add the personal access token.");
    const token = githubForm.querySelector<HTMLInputElement>('input[type="password"]') as HTMLInputElement;
    await act(async () => setValue(token, "ghp_test"));
    await act(async () => githubForm.requestSubmit());
    expect(servers.at(-1)).toMatchObject({ name: "github", headers: { Authorization: "Bearer ghp_test" } });
    expect(catalog.querySelector('[data-entry="github"]')?.textContent).toContain("Added");
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
