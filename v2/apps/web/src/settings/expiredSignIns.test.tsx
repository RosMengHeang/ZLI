// @vitest-environment jsdom

import { CommandId, McpListResult } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ExpiredSignInNotice } from "./ExpiredSignInNotice.js";
import { expiredSignInMessage, expiredSignIns } from "./expiredSignIns.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("expired sign-ins", () => {
  it("names expired sign-ins by their catalog title when there is one", () => {
    const result = McpListResult.parse({
      servers: [
        {
          name: "work-linear",
          enabled: true,
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: {},
          oauth: true,
        },
        { name: "vercel", enabled: true, transport: "http", url: "https://mcp.vercel.com", headers: {}, oauth: true },
      ],
      agentAccess: "full",
      userSettings: { enabled: true, outcomes: [] },
      signIns: [
        { name: "work-linear", url: "https://mcp.linear.app/mcp", signedIn: false, expired: true },
        { name: "vercel", url: "https://mcp.vercel.com", signedIn: false },
        { name: "plugin-notion", url: "https://mcp.notion.com/mcp", signedIn: false, expired: true },
        { name: "acme", url: "https://mcp.acme.dev/mcp", signedIn: false, expired: true },
      ],
    });
    expect(expiredSignIns(result)).toEqual([
      { name: "work-linear", title: "Linear", connectorId: "linear" },
      { name: "plugin-notion", title: "Notion", connectorId: "notion" },
      { name: "acme", title: "acme" },
    ]);
  });

  it("phrases the notice for one or more sign-ins", () => {
    expect(expiredSignInMessage([{ name: "linear", title: "Linear" }])).toBe("Your sign-in to Linear expired.");
    expect(
      expiredSignInMessage([
        { name: "linear", title: "Linear" },
        { name: "notion", title: "Notion" },
        { name: "acme", title: "acme" },
      ]),
    ).toBe("Your sign-ins to Linear, Notion, and acme expired.");
  });
});

describe("ExpiredSignInNotice", () => {
  it("checks on mount and when the window gets focus, and opens the connector", async () => {
    let calls = 0;
    let expired = true;
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string }) => {
          calls += 1;
          return {
            commandId: CommandId.parse(request.commandId),
            accepted: true as const,
            result: McpListResult.parse({
              servers: [],
              agentAccess: "full",
              userSettings: { enabled: true, outcomes: [] },
              signIns: [{ name: "linear", url: "https://mcp.linear.app/mcp", signedIn: false, expired }],
            }),
          };
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
    } as unknown as ZliBridge;
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge}>
          <ExpiredSignInNotice onSignInAgain={(id) => opened.push(id)} />
        </RuntimeProvider>,
      );
    });
    expect(calls).toBe(1);
    expect(container.textContent).toContain("Your sign-in to Linear expired.");
    const again = [...container.querySelectorAll("button")].find((node) => node.textContent === "Sign in again");
    await act(async () => again?.click());
    expect(opened).toEqual(["linear"]);
    expect(container.textContent).toBe("");

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(calls).toBe(2);
    expect(container.textContent).toBe("");
    expired = false;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expired = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(calls).toBe(4);
    expect(container.textContent).toContain("Your sign-in to Linear expired.");
  });
});
