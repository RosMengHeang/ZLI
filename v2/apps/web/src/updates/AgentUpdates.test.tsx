// @vitest-environment jsdom
import type { ProviderUpdateInfo } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { AgentUpdates, agentVersionText } from "./AgentUpdates.js";
import { resetAgentUpdates } from "./agentUpdatesStore.js";

const codex: ProviderUpdateInfo = {
  provider: "codex",
  displayName: "Codex",
  current: "0.50.0",
  latest: "0.60.0",
  status: "behind",
  method: "npm",
  canUpdate: true,
  command: "npm install -g @openai/codex@latest",
};
const gemini: ProviderUpdateInfo = {
  provider: "gemini",
  displayName: "Gemini",
  current: "1.0.0",
  status: "unknown",
  method: "manual",
  canUpdate: false,
  command: "npm install -g @google/gemini-cli@latest",
};

async function mount() {
  resetAgentUpdates();
  const commands: string[] = [];
  const dispatch = vi.fn(async (request: { commandId: string; command: { type: string } }) => {
    commands.push(request.command.type);
    const result =
      request.command.type === "providers.update"
        ? {
            provider: "codex",
            outcome: "updated",
            message: "Codex is now on 0.60.0.",
            updates: [{ ...codex, current: "0.60.0", status: "current" }, gemini],
          }
        : { updates: [codex, gemini] };
    return { commandId: request.commandId, accepted: true, result };
  });
  const bridge = {
    runtime: { getProjection: async () => undefined, onProjection: () => () => undefined, dispatch },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <AgentUpdates />
      </RuntimeProvider>,
    );
  });
  return { container, commands, root };
}

const buttons = (container: HTMLElement) => [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("AgentUpdates", () => {
  it("says how far behind each agent is", () => {
    expect(agentVersionText(codex)).toBe("0.50.0 installed, 0.60.0 is out");
    expect(agentVersionText({ ...codex, status: "current", current: "0.60.0" })).toBe("Up to date, 0.60.0");
    expect(agentVersionText(gemini)).toBe("Version 1.0.0");
  });

  it("updates an agent that is behind, and offers the command for one it cannot update", async () => {
    const { container, commands, root } = await mount();
    expect(commands).toEqual(["providers.checkUpdates"]);
    expect(buttons(container)).toEqual(["Check again", "Update", "Copy command"]);
    const update = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Update");
    await act(async () => update?.click());
    expect(commands).toEqual(["providers.checkUpdates", "providers.update"]);
    expect(container.textContent).toContain("Codex is now on 0.60.0.");
    expect(container.textContent).toContain("Up to date, 0.60.0");
    expect(buttons(container)).toEqual(["Check again", "Copy command"]);
    act(() => root.unmount());
  });
});
