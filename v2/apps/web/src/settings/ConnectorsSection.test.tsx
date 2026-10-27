// @vitest-environment jsdom

import { CommandId, MCP_CATALOG, McpListResult, type McpServerConfig } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ConnectorsSection, connectorMatches, connectorState } from "./ConnectorsSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const entry = (id: string) => {
  const found = MCP_CATALOG.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No catalog entry ${id}`);
  return found;
};

const vercel: McpServerConfig = {
  name: "vercel",
  enabled: true,
  transport: "http",
  url: "https://mcp.vercel.com",
  headers: {},
  oauth: true,
};

const listOf = (servers: McpServerConfig[], signedIn: string[] = []): McpListResult => ({
  servers,
  agentAccess: "full",
  userSettings: { enabled: true, outcomes: [] },
  health: [],
  signIns: servers
    .filter((server) => server.transport === "http" && server.oauth)
    .map((server) => ({
      name: server.name,
      url: server.transport === "http" ? server.url : "",
      signedIn: signedIn.includes(server.name),
      ...(signedIn.includes(server.name) ? { via: "browser" as const, account: "ada" } : {}),
    })),
});

describe("connector helpers", () => {
  it("decides each card's state from the saved servers and sign-ins", () => {
    expect(connectorState(entry("vercel"), listOf([]), {})).toEqual({ kind: "new" });
    expect(connectorState(entry("vercel"), listOf([vercel]), {})).toMatchObject({ kind: "signed-out" });
    expect(connectorState(entry("vercel"), listOf([vercel], ["vercel"]), {})).toMatchObject({
      kind: "connected",
      detail: "Signed in as ada",
    });
    expect(connectorState(entry("vercel"), listOf([{ ...vercel, enabled: false }]), {})).toMatchObject({
      kind: "off",
    });
    const expired = McpListResult.parse({
      ...listOf([vercel]),
      signIns: [{ name: "vercel", url: vercel.url, signedIn: false, expired: true }],
    });
    expect(connectorState(entry("vercel"), expired, {})).toMatchObject({ kind: "expired" });
    const pending = { vercel: { name: "vercel", attemptId: "a", url: "https://vercel.com/oauth" } };
    expect(connectorState(entry("vercel"), listOf([vercel]), pending)).toMatchObject({ kind: "pending" });
  });

  it("matches every search word against the name, description, and category", () => {
    expect(connectorMatches(entry("vercel"), "vercel deploy")).toBe(true);
    expect(connectorMatches(entry("vercel"), "  ")).toBe(true);
    expect(connectorMatches(entry("vercel"), "stripe")).toBe(false);
  });
});

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function card(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-entry="${id}"]`);
  if (!found) throw new Error(`No card ${id}`);
  return found;
}

describe("ConnectorsSection", () => {
  it("connects with one click, signs in through the browser, and disconnects", async () => {
    let servers: McpServerConfig[] = [];
    let signedIn: string[] = [];
    const opened: string[] = [];
    const commands: string[] = [];
    const bridge = {
      runtime: {
        dispatch: async (request: {
          commandId: string;
          command: { type: string; servers?: McpServerConfig[]; name?: string };
        }) => {
          commands.push(request.command.type);
          const reply = (result: unknown) => ({
            commandId: CommandId.parse(request.commandId),
            accepted: true as const,
            result,
          });
          if (request.command.type === "mcp.save") servers = request.command.servers ?? [];
          if (request.command.type === "mcp.signIn") {
            return reply({ status: "open", attemptId: "attempt-1", url: "https://vercel.com/oauth/authorize?x=1" });
          }
          if (request.command.type === "mcp.signIn.wait") signedIn = ["vercel"];
          if (request.command.type === "mcp.signOut") signedIn = [];
          return reply(listOf(servers, signedIn));
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
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge}>
          <ConnectorsSection query="" />
        </RuntimeProvider>,
      );
    });

    expect(container.querySelector(".connector-group h4")?.textContent).toBe("Code and deploy");
    expect(card(container, "vercel").querySelector(".connector-logo")).not.toBeNull();

    await act(async () => button(card(container, "vercel"), "Connect Vercel").click());
    expect(servers).toEqual([vercel]);
    expect(commands).toEqual(["mcp.list", "mcp.save", "mcp.signIn", "mcp.signIn.wait"]);
    expect(opened).toEqual(["https://vercel.com/oauth/authorize?x=1"]);
    expect(card(container, "vercel").dataset.state).toBe("connected");
    expect(card(container, "vercel").textContent).toContain("Signed in as ada");

    await act(async () => button(card(container, "vercel"), "Disconnect Vercel").click());
    await act(async () => button(card(container, "vercel"), "Disconnect").click());
    expect(commands.slice(-2)).toEqual(["mcp.signOut", "mcp.save"]);
    expect(servers).toEqual([]);
    expect(card(container, "vercel").dataset.state).toBe("new");
  });

  it("adds GitHub with a token instead of signing in, and filters by search", async () => {
    let servers: McpServerConfig[] = [];
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string; command: { type: string; servers?: McpServerConfig[] } }) => {
          if (request.command.type === "mcp.save") servers = request.command.servers ?? [];
          return { commandId: CommandId.parse(request.commandId), accepted: true as const, result: listOf(servers) };
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const search = (query: string) =>
      act(async () => {
        root.render(
          <RuntimeProvider bridge={bridge}>
            <ConnectorsSection query={query} />
          </RuntimeProvider>,
        );
      });
    await search("github");
    expect([...container.querySelectorAll("[data-entry]")].map((item) => item.getAttribute("data-entry"))).toEqual([
      "github",
    ]);

    await act(async () => button(card(container, "github"), "Use a token").click());
    const form = card(container, "github").querySelector("form") as HTMLFormElement;
    await act(async () => form.requestSubmit());
    expect(card(container, "github").textContent).toContain("Add the personal access token.");
    await act(async () => setValue(form.querySelector("input") as HTMLInputElement, "github_pat_1"));
    await act(async () => form.requestSubmit());
    expect(servers).toEqual([
      {
        name: "github",
        enabled: true,
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer github_pat_1" },
        oauth: false,
      },
    ]);
    expect(card(container, "github").dataset.state).toBe("connected");
    expect(container.textContent).not.toContain("github_pat_1");

    await search("nothing like this");
    expect(container.textContent).toContain("No connectors match.");
  });
});

type Command = { type: string; servers?: McpServerConfig[]; name?: string; attemptId?: string };

async function renderWith(
  handle: (command: Command) => unknown,
  projects: { projectId: string; path: string; name: string }[] = [],
): Promise<HTMLElement> {
  const bridge = {
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
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <ConnectorsSection query="" />
      </RuntimeProvider>,
    );
  });
  return container;
}

describe("ConnectorsSection health and projects", () => {
  it("tests a connected card and limits it to a project", async () => {
    let servers: McpServerConfig[] = [vercel];
    let health: McpListResult["health"] = [];
    const container = await renderWith(
      (command) => {
        if (command.type === "mcp.test") {
          health = [{ name: "vercel", ok: true, toolCount: 3, testedAt: "2025-01-02T03:04:05.000Z" }];
          return {
            name: "vercel",
            ok: true,
            tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
            testedAt: "2025-01-02T03:04:05.000Z",
          };
        }
        if (command.type === "mcp.save") servers = command.servers ?? [];
        return McpListResult.parse({ ...listOf(servers, ["vercel"]), health });
      },
      [{ projectId: "00000000-0000-4000-8000-000000000001", path: "/work/repo", name: "repo" }],
    );
    const vercelCard = () => card(container, "vercel");
    expect(vercelCard().textContent).toContain("Not tested");
    await act(async () => button(vercelCard(), "Test Vercel").click());
    expect(vercelCard().textContent).toContain("3 tools");
    expect(vercelCard().querySelector('[aria-label="Working, 3 tools"]')).not.toBeNull();

    await act(async () => button(vercelCard(), "Projects for Vercel: All projects").click());
    const popover = vercelCard().querySelector('[role="dialog"]') as HTMLElement;
    expect(popover.textContent).toContain("skip servers limited to some projects");
    await act(async () => popover.querySelector<HTMLInputElement>('input[aria-label="repo"]')?.click());
    expect(servers).toEqual([{ ...vercel, projects: ["/work/repo"] }]);
    expect(button(vercelCard(), "Projects for Vercel: 1 project")).toBeTruthy();
    await act(async () =>
      vercelCard().querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="All projects"]')?.click(),
    );
    expect(servers).toEqual([vercel]);
  });

  it("asks to sign in again when a connector's sign-in expired", async () => {
    let expired = true;
    const container = await renderWith((command) => {
      if (command.type === "mcp.signIn") expired = false;
      const list = listOf([vercel], expired ? [] : ["vercel"]);
      const result = McpListResult.parse({
        ...list,
        signIns: expired ? [{ name: "vercel", url: vercel.url, signedIn: false, expired: true }] : list.signIns,
      });
      return command.type === "mcp.signIn" ? { status: "done", list: result } : result;
    });
    expect(card(container, "vercel").dataset.state).toBe("expired");
    expect(card(container, "vercel").textContent).toContain("Sign-in expired");
    await act(async () => button(card(container, "vercel"), "Sign in again to Vercel").click());
    expect(card(container, "vercel").dataset.state).toBe("connected");
  });
  it("shows the browser sign-in inside the card while it waits", async () => {
    let finish: () => void = () => undefined;
    const opened: string[] = [];
    let servers: McpServerConfig[] = [];
    let signedIn: string[] = [];
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string; command: Command }) => {
          const { command } = request;
          if (command.type === "mcp.save") servers = command.servers ?? [];
          let result: unknown = listOf(servers, signedIn);
          if (command.type === "mcp.signIn") {
            result = { status: "open", attemptId: "attempt-1", url: "https://vercel.com/oauth", code: "WXYZ-1234" };
          }
          if (command.type === "mcp.signIn.wait") {
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            signedIn = ["vercel"];
            result = listOf(servers, signedIn);
          }
          return { commandId: CommandId.parse(request.commandId), accepted: true as const, result };
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
        writeClipboard: async () => undefined,
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge}>
          <ConnectorsSection query="" />
        </RuntimeProvider>,
      );
    });

    await act(async () => button(card(container, "vercel"), "Connect Vercel").click());
    const waiting = card(container, "vercel");
    expect(waiting.dataset.state).toBe("pending");
    expect(waiting.classList.contains("is-open")).toBe(true);
    expect(waiting.querySelector('[role="status"]')?.textContent).toContain("Waiting for you to sign in to Vercel");
    expect(waiting.querySelector(".connector-code")?.textContent).toBe("WXYZ-1234");

    await act(async () => button(waiting, "Open again").click());
    expect(opened.at(-1)).toBe("https://vercel.com/oauth");

    await act(async () => finish());
    expect(card(container, "vercel").dataset.state).toBe("connected");
    expect(card(container, "vercel").classList.contains("is-open")).toBe(false);
  });
});
