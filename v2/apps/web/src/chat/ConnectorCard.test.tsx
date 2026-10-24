// @vitest-environment jsdom

import { CommandId, McpListResult, type McpServerConfig, type ThreadActivityConnector } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ConnectorCard, connectorNeed, connectorTarget } from "./ConnectorCard.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const remote = (name: string, url: string): McpServerConfig => ({
  name,
  enabled: true,
  transport: "http",
  url,
  headers: {},
  oauth: true,
});
const linear = remote("linear", "https://mcp.linear.app/mcp");

const listOf = (servers: McpServerConfig[], signedIn: string[] = []): McpListResult =>
  McpListResult.parse({
    servers,
    agentAccess: "full",
    userSettings: { enabled: true, outcomes: [] },
    signIns: servers
      .filter((server) => server.transport === "http" && server.oauth)
      .map((server) => ({
        name: server.name,
        url: server.transport === "http" ? server.url : "",
        signedIn: signedIn.includes(server.name),
      })),
  });

function fakeBridge(initial: McpServerConfig[], signedInAtStart: string[] = []) {
  let servers = initial;
  let signedIn = signedInAtStart;
  const commands: string[] = [];
  const opened: string[] = [];
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
          return reply({ status: "open", attemptId: "attempt-1", url: `https://sign.in/${request.command.name}` });
        }
        if (request.command.type === "mcp.signIn.wait") signedIn = servers.map((server) => server.name);
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
  return { bridge, commands, opened, servers: () => servers };
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

async function renderCard(
  bridge: ZliBridge,
  connector: ThreadActivityConnector,
  handlers: {
    onTryAgain?: (text: string) => Promise<boolean>;
    onNewChat?: () => void;
    onOpenConnectors?: (id?: string) => void;
    onDismiss?: () => void;
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <ConnectorCard
          connector={connector}
          displayName="Codex"
          onTryAgain={handlers.onTryAgain}
          onNewChat={handlers.onNewChat ?? (() => undefined)}
          onOpenConnectors={handlers.onOpenConnectors}
          onDismiss={handlers.onDismiss ?? (() => undefined)}
        />
      </RuntimeProvider>,
    );
  });
  return container;
}

describe("connector helpers", () => {
  it("matches a connector by server name, catalog id, or title and says what it still needs", () => {
    const custom = remote("work-linear", "https://mcp.linear.app/mcp");
    const result = listOf([custom]);
    const target = connectorTarget("work-linear", result);
    expect([target.id, target.title, target.server?.name]).toEqual(["linear", "Linear", "work-linear"]);
    expect(connectorNeed(target, result)).toBe("sign-in");
    expect(connectorNeed(connectorTarget("Vercel", result), result)).toBe("add");
    expect(connectorNeed(connectorTarget("render", result), result)).toBe("settings");
    expect(connectorNeed(connectorTarget("nope", result), result)).toBe("settings");
    expect(connectorNeed(connectorTarget("linear", listOf([linear], ["linear"])), listOf([linear], ["linear"]))).toBe(
      "none",
    );
  });
});

describe("ConnectorCard", () => {
  it("signs in through the browser and then asks the agent to try again", async () => {
    const fake = fakeBridge([linear]);
    const sent: string[] = [];
    const container = await renderCard(
      fake.bridge,
      { server: "linear", reason: "sign-in" },
      {
        onTryAgain: async (text) => {
          sent.push(text);
          return true;
        },
      },
    );
    expect(container.textContent).toContain("Linear needs you to sign in");
    expect(container.querySelector(".connector-logo")).not.toBeNull();

    await act(async () => button(container, "Sign in").click());
    expect(fake.commands).toEqual(["mcp.list", "mcp.signIn", "mcp.signIn.wait"]);
    expect(fake.opened).toEqual(["https://sign.in/linear"]);
    expect(container.textContent).toContain("Signed in to Linear");

    await act(async () => button(container, "Try again").click());
    expect(sent).toEqual(["I signed in to Linear. Please try again."]);
  });

  it("adds a requested catalog connector, signs in, and offers a new chat", async () => {
    const fake = fakeBridge([]);
    let restarted = 0;
    const container = await renderCard(
      fake.bridge,
      { server: "vercel", reason: "request" },
      {
        onNewChat: () => {
          restarted += 1;
        },
      },
    );
    expect(container.textContent).toContain("Codex asks to connect Vercel");

    await act(async () => button(container, "Connect").click());
    expect(fake.servers().map((server) => server.name)).toEqual(["vercel"]);
    expect(fake.commands).toEqual(["mcp.list", "mcp.save", "mcp.signIn", "mcp.signIn.wait"]);
    expect(container.textContent).toContain("Vercel is connected");
    expect(container.textContent).toContain("Start a new chat so the agent can use it.");

    await act(async () => button(container, "New chat").click());
    expect(restarted).toBe(1);
  });

  it("stays hidden once connected, sends connectors with fields to Settings, and can be dismissed", async () => {
    const ready = await renderCard(fakeBridge([linear], ["linear"]).bridge, { server: "linear", reason: "sign-in" });
    expect(ready.textContent).toBe("");

    const opened: Array<string | undefined> = [];
    let dismissed = 0;
    const container = await renderCard(
      fakeBridge([]).bridge,
      { server: "render", reason: "request" },
      {
        onOpenConnectors: (id) => opened.push(id),
        onDismiss: () => {
          dismissed += 1;
        },
      },
    );
    await act(async () => button(container, "Open Settings").click());
    expect(opened).toEqual(["render"]);
    await act(async () => button(container, "Not now").click());
    expect(dismissed).toBe(1);
  });
});
