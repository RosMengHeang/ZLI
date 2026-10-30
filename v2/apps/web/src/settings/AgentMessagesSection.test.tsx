// @vitest-environment jsdom

import { CommandId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { AgentMessagesSection } from "./AgentMessagesSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AgentMessagesSection", () => {
  it("sets what agents may do and which projects they reach", async () => {
    let agentAccess = "full";
    let agentScope = "project";
    const bridge = {
      runtime: {
        dispatch: async (request: {
          commandId: string;
          command: { type: string; access?: string; scope?: string };
        }) => {
          if (request.command.type === "mcp.agentAccess") agentAccess = request.command.access ?? agentAccess;
          if (request.command.type === "mcp.agentScope") agentScope = request.command.scope ?? agentScope;
          return {
            commandId: CommandId.parse(request.commandId),
            accepted: true as const,
            result: { servers: [], agentAccess, agentScope, userSettings: { enabled: true, outcomes: [] } },
          };
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RuntimeProvider bridge={bridge}>
          <AgentMessagesSection />
        </RuntimeProvider>,
      );
    });
    const pick = async (label: string, option: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`);
      await act(async () => trigger?.click());
      await act(async () =>
        document.querySelector<HTMLButtonElement>(`[role="option"][data-label="${option}"]`)?.click(),
      );
      return trigger;
    };
    expect(container.textContent).toContain("When one tries to reach another project, ZLI asks you first.");

    const scope = await pick("Which agents they can reach", "In every project");
    expect(agentScope).toBe("all");
    expect(scope?.getAttribute("aria-label")).toBe("Which agents they can reach: In every project");
    expect(container.textContent).toContain("in every project, by name");

    const access = await pick("What agents may do with other agents", "Off");
    expect(agentAccess).toBe("off");
    expect(access?.getAttribute("aria-label")).toBe("What agents may do with other agents: Off");
    expect(
      container
        .querySelector<HTMLButtonElement>('button[aria-label^="Which agents they can reach"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => root.unmount());
  });
});
