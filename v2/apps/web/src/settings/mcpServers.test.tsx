// @vitest-environment jsdom

import { CommandId, McpListResult, type McpServerConfig, type McpTestResult } from "@zli-v2/contracts";
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
  mergeHealth,
  pluginSignIns,
  serverStatus,
  serverSummary,
  settingsProblems,
  withDisabledTools,
  withProjects,
} from "./mcpServers.js";
import { applyImports, defaultImportChoice } from "./McpImportPanel.js";

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
    expect(summary).toBe("https://mcp.context7.com/mcp · Authorization: ••••");
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

  it("adds a remote server and signs in to one through the browser", async () => {
    let servers: McpServerConfig[] = [];
    let signedIn = false;
    const opened: string[] = [];
    const list = () => ({
      servers,
      agentAccess: "full",
      userSettings: { enabled: true, outcomes: [] },
      signIns: servers
        .filter((server) => server.transport === "http" && server.oauth)
        .map((server) => ({
          name: server.name,
          url: server.transport === "http" ? server.url : "",
          signedIn,
          ...(signedIn ? { via: "browser", account: "ada" } : {}),
        })),
    });
    const bridge = {
      runtime: {
        dispatch: async (request: {
          commandId: string;
          command: { type: string; servers?: McpServerConfig[]; name?: string; attemptId?: string };
        }) => {
          const reply = (result: unknown) => ({
            commandId: CommandId.parse(request.commandId),
            accepted: true as const,
            result,
          });
          if (request.command.type === "mcp.save") servers = request.command.servers ?? [];
          if (request.command.type === "mcp.signIn") {
            return reply({ status: "open", attemptId: "attempt-1", url: "https://auth.example.com/authorize?x=1" });
          }
          if (request.command.type === "mcp.signIn.wait") signedIn = true;
          if (request.command.type === "mcp.signOut") signedIn = false;
          return reply(list());
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
      app: {
        getVersion: async () => "0",
        quit: async () => undefined,
        openExternal: async (url: string) => {
          opened.push(url);
        },
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    let openedConnectors = false;
    let root = createRoot(container);
    await act(async () => {
      root.render(
        <RuntimeProvider bridge={bridge}>
          <McpServersSection onOpenConnectors={() => (openedConnectors = true)} />
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

    const linear = {
      name: "linear",
      enabled: true,
      transport: "http" as const,
      url: "https://mcp.linear.app/mcp",
      headers: {},
      oauth: true,
    };
    servers = [...servers, linear];
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <RuntimeProvider bridge={bridge}>
          <McpServersSection onOpenConnectors={() => (openedConnectors = true)} />
        </RuntimeProvider>,
      );
    });
    expect(container.textContent).toContain("linear");
    await act(async () => button(container, "Sign in").click());
    expect(opened).toEqual(["https://auth.example.com/authorize?x=1"]);
    expect(container.querySelector(".mcp-row-signin")?.textContent).toBe("Signed in as ada");
    await act(async () => button(container, "Sign out").click());
    expect(button(container, "Sign in")).toBeTruthy();

    await act(async () => button(container, "Browse connectors").click());
    expect(openedConnectors).toBe(true);
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

const testedAt = "2025-01-02T03:04:05.000Z";

const toolsReply = (name: string): McpTestResult => ({
  name,
  ok: true,
  tools: [{ name: "search_issues", description: "Find issues." }, { name: "create_issue" }],
  testedAt,
});

describe("MCP status, tools, and projects helpers", () => {
  const linear: McpServerConfig = {
    name: "linear",
    enabled: true,
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    headers: {},
    oauth: true,
  };
  const list = (patch: Partial<McpListResult> = {}) =>
    McpListResult.parse({
      servers: [github, linear],
      agentAccess: "full",
      userSettings: { enabled: true, outcomes: [] },
      ...patch,
    });

  it("says what the status dot means", () => {
    expect(serverStatus(list(), "github")).toEqual({ tone: "unknown", label: "Not tested" });
    expect(serverStatus(list({ health: [{ name: "github", ok: true, toolCount: 1, testedAt }] }), "github")).toEqual({
      tone: "ok",
      label: "Working, 1 tool",
    });
    expect(
      serverStatus(
        list({ health: [{ name: "github", ok: false, toolCount: 0, problem: "npx was not found.", testedAt }] }),
        "github",
      ),
    ).toEqual({ tone: "problem", label: "npx was not found." });
    const signIn = { name: "linear", url: linear.url, signedIn: false };
    expect(serverStatus(list({ signIns: [signIn] }), "linear")).toEqual({ tone: "warning", label: "Not signed in" });
    expect(serverStatus(list({ signIns: [{ ...signIn, expired: true }] }), "linear")).toEqual({
      tone: "warning",
      label: "Sign-in expired",
    });
  });

  it("merges a test into the health list by name and lists plugin sign-ins", () => {
    const merged = mergeHealth(
      [
        { name: "GitHub", ok: false, toolCount: 0, testedAt },
        { name: "docs", ok: true, toolCount: 4, testedAt },
      ],
      toolsReply("github"),
    );
    expect(merged.map((entry) => [entry.name, entry.ok, entry.toolCount])).toEqual([
      ["docs", true, 4],
      ["github", true, 2],
    ]);
    const result = list({
      signIns: [
        { name: "linear", url: linear.url, signedIn: true },
        { name: "acme", url: "https://mcp.acme.dev/mcp", signedIn: false },
      ],
    });
    expect(pluginSignIns(result).map((entry) => entry.name)).toEqual(["acme"]);
  });

  it("leaves empty tool and project lists out of the saved server", () => {
    expect(withDisabledTools({ ...github, disabledTools: ["a"] }, [])).toEqual(github);
    expect(withDisabledTools(github, ["a"])).toEqual({ ...github, disabledTools: ["a"] });
    expect(withProjects({ ...github, projects: ["/repo"] }, [])).toEqual(github);
    expect(applyDraft([], { ...draftFromServer({ ...github, disabledTools: ["x"] }) }, undefined)).toEqual({
      servers: [{ ...github, disabledTools: ["x"] }],
    });
    expect(applyDraft([], { ...draftFromServer(github), limitProjects: true }, undefined)).toEqual({
      problem: "Pick at least one project, or choose All projects.",
    });
    expect(applyDraft([], { ...draftFromServer(github), limitProjects: true, projects: ["/repo"] }, undefined)).toEqual(
      { servers: [{ ...github, projects: ["/repo"] }] },
    );
    expect(
      applyDraft([], { ...draftFromServer(github), limitProjects: false, projects: ["/repo"] }, undefined),
    ).toEqual({ servers: [github] });
  });

  it("picks import candidates and appends them", () => {
    const memory: McpServerConfig = { name: "memory", enabled: true, command: "npx", args: [], env: {} };
    const candidate = (server: McpServerConfig, exists = false) => ({
      app: "cursor" as const,
      appLabel: "Cursor",
      path: "/home/a/.cursor/mcp.json",
      server,
      exists,
    });
    expect(defaultImportChoice([candidate(github, true), candidate(memory), candidate(memory)])).toEqual([
      false,
      true,
      false,
    ]);
    expect(applyImports([github], [memory])).toEqual({ servers: [github, memory] });
    expect(applyImports([github], [memory, memory])).toEqual({ problem: "memory: memory is listed twice." });
  });
});

type Command = { type: string; servers?: McpServerConfig[]; name?: string; attemptId?: string };

function fakeBridge(
  handle: (command: Command) => unknown,
  projects: { projectId: string; path: string; name: string }[] = [],
): ZliBridge {
  return {
    runtime: {
      dispatch: async (request: { commandId: string; command: Command }) => ({
        commandId: CommandId.parse(request.commandId),
        accepted: true as const,
        result: await handle(request.command),
      }),
      getProjection: async () => (projects.length > 0 ? { lastSequence: 1, projects } : undefined),
      onProjection: () => () => undefined,
    },
    app: { getVersion: async () => "0", quit: async () => undefined, openExternal: async () => undefined },
  } as unknown as ZliBridge;
}

async function renderSection(bridge: ZliBridge): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <McpServersSection />
      </RuntimeProvider>,
    );
  });
  return container;
}

describe("McpServersSection tests, tools, projects, and import", () => {
  it("tests a server, lists its tools, and turns single tools off", async () => {
    let servers: McpServerConfig[] = [github];
    let health: McpListResult["health"] = [];
    const saves: McpServerConfig[][] = [];
    const list = () =>
      McpListResult.parse({
        servers,
        agentAccess: "full",
        userSettings: { enabled: true, outcomes: [] },
        health,
        signIns: [{ name: "plugin-docs", url: "https://docs.example.com/mcp", signedIn: true, account: "ada" }],
      });
    const container = await renderSection(
      fakeBridge((command) => {
        if (command.type === "mcp.test") {
          const reply = toolsReply(command.name ?? "");
          health = [{ name: reply.name, ok: true, toolCount: reply.tools.length, testedAt }];
          return reply;
        }
        if (command.type === "mcp.save") {
          servers = command.servers ?? [];
          saves.push(servers);
          health = [];
        }
        return list();
      }),
    );

    expect(
      container.querySelectorAll(".mcp-rows")[1]?.querySelector(".mcp-status-dot")?.getAttribute("aria-label"),
    ).toBe("Not tested");
    await act(async () => button(container, "Test github").click());
    const panel = container.querySelector('section[aria-label="Tools in github"]') as HTMLElement;
    expect(panel.textContent).toContain("2 of 2 tools on");
    expect(panel.textContent).toContain("search_issues");
    expect(panel.textContent).toContain("Find issues.");
    expect(container.querySelector('[aria-label="Working, 2 tools"]')).not.toBeNull();

    await act(async () =>
      panel.querySelector<HTMLInputElement>('input[aria-label="Let agents use create_issue"]')?.click(),
    );
    expect(saves.at(-1)).toEqual([{ ...github, disabledTools: ["create_issue"] }]);
    const updated = container.querySelector('section[aria-label="Tools in github"]') as HTMLElement;
    expect(updated.textContent).toContain("1 of 2 tools on");
    expect(updated.textContent).toContain("Changes apply to agents started after you save.");
    await act(async () => button(updated, "Turn all on").click());
    expect(saves.at(-1)).toEqual([github]);

    await act(async () => button(container, "Test plugin-docs").click());
    const pluginPanel = container.querySelector('section[aria-label="Tools in plugin-docs"]') as HTMLElement;
    expect(pluginPanel.textContent).toContain("Plugin servers use every tool.");
    expect(pluginPanel.querySelector('input[role="switch"]')).toBeNull();
    await act(async () => button(pluginPanel, "Hide tools in plugin-docs").click());
    expect(container.querySelector('section[aria-label="Tools in plugin-docs"]')).toBeNull();
  });

  it("limits a server to some projects", async () => {
    let servers: McpServerConfig[] = [github];
    const container = await renderSection(
      fakeBridge(
        (command) => {
          if (command.type === "mcp.save") servers = command.servers ?? [];
          return McpListResult.parse({ servers, agentAccess: "full", userSettings: { enabled: true, outcomes: [] } });
        },
        [
          { projectId: "00000000-0000-4000-8000-000000000001", path: "/work/repo", name: "repo" },
          { projectId: "00000000-0000-4000-8000-000000000002", path: "/work/site", name: "site" },
        ],
      ),
    );
    await act(async () => button(container, "Edit github").click());
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.textContent).toContain("Cursor and Droid, and Gemini, Kimi Code, and Qwen Code in terminals");
    const [all, some] = [...form.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(all?.checked).toBe(true);
    await act(async () => some?.click());
    await act(async () => form.requestSubmit());
    expect(form.textContent).toContain("Pick at least one project, or choose All projects.");
    await act(async () => form.querySelector<HTMLInputElement>('input[aria-label="site"]')?.click());
    await act(async () => form.requestSubmit());
    expect(servers).toEqual([{ ...github, projects: ["/work/site"] }]);
    const chip = container.querySelector(".mcp-chip");
    expect(chip?.textContent).toBe("1 project");
    expect(chip?.getAttribute("data-tooltip")).toBe("site");

    await act(async () => button(container, "Edit github").click());
    const again = container.querySelector("form") as HTMLFormElement;
    await act(async () => again.querySelector<HTMLInputElement>('input[type="radio"]')?.click());
    await act(async () => again.requestSubmit());
    expect(servers).toEqual([github]);
  });

  it("imports servers from other apps", async () => {
    let servers: McpServerConfig[] = [github];
    const memory: McpServerConfig = {
      name: "memory",
      enabled: true,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: {},
    };
    const container = await renderSection(
      fakeBridge((command) => {
        if (command.type === "mcp.import.scan") {
          return {
            found: [
              { app: "cursor", appLabel: "Cursor", path: "/home/a/.cursor/mcp.json", server: memory, exists: false },
              { app: "cursor", appLabel: "Cursor", path: "/home/a/.cursor/mcp.json", server: github, exists: true },
              {
                app: "claude-code",
                appLabel: "Claude Code",
                path: "/home/a/.claude.json",
                server: {
                  name: "docs",
                  enabled: true,
                  transport: "http",
                  url: "https://docs.example.com/mcp",
                  headers: {},
                  oauth: false,
                },
                exists: false,
                note: "Sign in again in ZLI after importing.",
              },
            ],
            problems: ["Windsurf: the file is not plain JSON."],
          };
        }
        if (command.type === "mcp.save") servers = command.servers ?? [];
        return McpListResult.parse({ servers, agentAccess: "full", userSettings: { enabled: true, outcomes: [] } });
      }),
    );
    await act(async () => button(container, "Import from other apps").click());
    const panel = container.querySelector('section[aria-label="Import from other apps"]') as HTMLElement;
    expect([...panel.querySelectorAll("legend")].map((node) => node.textContent)).toEqual(["Cursor", "Claude Code"]);
    expect(panel.textContent).toContain("Already in ZLI");
    expect(panel.textContent).toContain("/home/a/.claude.json");
    expect(panel.textContent).toContain("Sign in again in ZLI after importing.");
    expect(panel.textContent).toContain("Windsurf: the file is not plain JSON.");
    const check = (label: string) => panel.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    expect(check("Import github from Cursor")?.disabled).toBe(true);
    expect(check("Import memory from Cursor")?.checked).toBe(true);
    expect(button(panel, "Import 2 servers")).toBeTruthy();
    await act(async () => check("Import docs from Claude Code")?.click());
    await act(async () => button(panel, "Import 1 server").click());
    expect(servers).toEqual([github, memory]);
    expect(container.querySelector('section[aria-label="Import from other apps"]')).toBeNull();
    expect(container.textContent).toContain("Imported 1 server.");
  });

  it("says when no other app has servers", async () => {
    const container = await renderSection(
      fakeBridge((command) =>
        command.type === "mcp.import.scan"
          ? { found: [], problems: [] }
          : McpListResult.parse({ servers: [], agentAccess: "full", userSettings: { enabled: true, outcomes: [] } }),
      ),
    );
    await act(async () => button(container, "Import from other apps").click());
    expect(container.textContent).toContain(
      "No servers found in Claude Desktop, Claude Code, Cursor, VS Code, or Windsurf.",
    );
    await act(async () => button(container, "Close").click());
    expect(button(container, "Import from other apps")).toBeTruthy();
  });

  it("asks to sign in again when a sign-in expired, and has no Goose footnote", async () => {
    const linear: McpServerConfig = {
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {},
      oauth: true,
    };
    const context7: McpServerConfig = {
      name: "context7",
      enabled: true,
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer x" },
      oauth: false,
    };
    let signedIn = false;
    const list = () =>
      McpListResult.parse({
        servers: [linear, context7],
        agentAccess: "full",
        userSettings: { enabled: true, outcomes: [] },
        signIns: [
          signedIn
            ? { name: "linear", url: linear.url, signedIn: true, via: "browser", account: "ada" }
            : { name: "linear", url: linear.url, signedIn: false, expired: true },
        ],
      });
    const container = await renderSection(
      fakeBridge((command) => {
        if (command.type === "mcp.signIn") {
          signedIn = true;
          return { status: "done", list: list() };
        }
        return list();
      }),
    );
    expect(container.textContent).not.toContain("Goose");
    expect(container.querySelector(".mcp-row-signin.is-expired")?.textContent).toBe("Sign-in expired");
    expect(container.querySelector('.mcp-status-dot[aria-label="Sign-in expired"]')).not.toBeNull();
    await act(async () => button(container, "Sign in again").click());
    expect(container.querySelector(".mcp-row-signin")?.textContent).toBe("Signed in as ada");
  });
});
