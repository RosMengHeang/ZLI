// @vitest-environment jsdom

import { CommandId, type PluginInstallPreview, type PluginListResult, type PluginSummary } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { combinePrompts } from "../prompts/prompts.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { PluginsSection } from "../settings/PluginsSection.js";
import { actionTerminalCommand, componentSummary } from "./plugins.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const components = {
  skills: ["helper"],
  mcpServers: ["docs", "local"],
  prompts: [{ name: "ship", description: "" }],
  actions: [{ name: "Test", description: "", command: "npm test" }],
  ignored: ["hooks"],
};

describe("plugin helpers", () => {
  it("summarizes parts and builds the terminal for an action", () => {
    expect(componentSummary(components)).toBe("1 skill, 2 MCP servers, 1 prompt, 1 action");
    expect(componentSummary({ skills: [], mcpServers: [], prompts: [], actions: [] })).toBeUndefined();
    const action = { plugin: "kit", name: "Test", description: "", command: "npm test && echo ok" };
    const worktree = { worktreeId: "w1", path: "/repo" };
    expect(actionTerminalCommand(action, worktree, false)).toMatchObject({
      type: "terminal.create",
      worktreeId: "w1",
      cwd: "/repo",
      title: "Test",
      shell: "/bin/bash",
      args: ["-lc", "npm test && echo ok"],
    });
    expect(actionTerminalCommand(action, worktree, true)).toMatchObject({
      shell: "cmd.exe",
      args: ["/d", "/s", "/c", '"npm test && echo ok"'],
    });
  });

  it("lists plugin prompts after shared and personal ones, named by plugin", () => {
    const prompts = combinePrompts(
      [{ name: "Shared", prompt: "S" }],
      [{ id: "p", name: "Mine", prompt: "M" }],
      [{ plugin: "kit", name: "ship", description: "", prompt: "Ship it." }],
    );
    expect(prompts.map((prompt) => [prompt.key, prompt.name, prompt.source])).toEqual([
      ["shared:0", "Shared", "shared"],
      ["personal:p", "Mine", "personal"],
      ["plugin:kit:ship", "kit:ship", "plugin"],
    ]);
  });
});

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}

const kit: PluginSummary = {
  name: "kit",
  displayName: "Kit",
  description: "Tools.",
  version: "1.0.0",
  format: "claude",
  enabled: true,
  path: "/data/plugins/kit",
  source: "https://github.com/acme/kit",
  installedAt: "2025-01-01T00:00:00.000Z",
  components,
  config: [{ key: "token", title: "API token", type: "string", sensitive: true, required: true }],
  configured: [],
  problems: ["Add API token in the plugin's settings."],
};

describe("PluginsSection", () => {
  it("installs a plugin, asks for its settings, and removes it", async () => {
    const commands: Array<Record<string, unknown>> = [];
    let result: PluginListResult = { plugins: [], pluginsPath: "/data/plugins" };
    const preview: PluginInstallPreview = {
      label: "acme/kit",
      candidates: [
        {
          name: "kit",
          displayName: "Kit",
          description: "Tools.",
          format: "claude",
          path: ".",
          components,
          config: kit.config,
          files: 4,
          bytes: 2048,
          exists: false,
        },
      ],
      elsewhere: [{ name: "far", description: "", source: "acme/far" }],
    };
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string; command: Record<string, unknown> }) => {
          const command = request.command as { type: string; values?: Record<string, string> };
          if (command.type !== "plugins.contributions") commands.push(request.command);
          let reply: unknown = result;
          if (command.type === "plugins.contributions") reply = { prompts: [], actions: [] };
          if (command.type === "plugins.previewInstall") reply = preview;
          if (command.type === "plugins.install") {
            result = { ...result, plugins: [kit] };
            reply = { ...result, installed: ["kit"] };
          }
          if (command.type === "plugins.configure") {
            result = { ...result, plugins: [{ ...kit, configured: ["token"], problems: [] }] };
            reply = result;
          }
          if (command.type === "plugins.remove") {
            result = { ...result, plugins: [] };
            reply = result;
          }
          return { commandId: CommandId.parse(request.commandId), accepted: true as const, result: reply };
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
          <PluginsSection />
        </RuntimeProvider>,
      );
    });
    expect(container.textContent).toContain("No plugins yet.");

    await act(async () => button(container, "Install plugin").click());
    const form = container.querySelector('form[aria-label="Install a plugin"]') as HTMLFormElement;
    await act(async () => setValue(form.querySelector("input") as HTMLInputElement, "acme/kit"));
    await act(async () => form.requestSubmit());
    expect(commands.at(-1)).toEqual({ type: "plugins.previewInstall", source: "acme/kit" });
    expect(container.textContent).toContain("1 skill, 2 MCP servers, 1 prompt, 1 action");
    expect(container.textContent).toContain("Test: npm test");
    expect(container.textContent).toContain("acme/far");

    await act(async () => button(container, "Install 1 plugin").click());
    expect(commands.at(-1)).toEqual({ type: "plugins.install", source: "acme/kit", names: ["kit"] });
    const settings = container.querySelector('form[aria-label="Settings for Kit"]') as HTMLFormElement;
    expect(settings).not.toBeNull();
    const token = settings.querySelector("input") as HTMLInputElement;
    expect(token.type).toBe("password");
    await act(async () => setValue(token, "s3cret"));
    await act(async () => settings.requestSubmit());
    expect(commands.at(-1)).toEqual({ type: "plugins.configure", name: "kit", values: { token: "s3cret" } });
    expect(container.textContent).not.toContain("Add API token");
    expect(container.textContent).toContain("Left out, since only Claude Code or Codex runs them: hooks.");

    await act(async () => button(container, "Remove Kit").click());
    await act(async () => button(container, "Remove").click());
    expect(commands.at(-1)).toEqual({ type: "plugins.remove", name: "kit" });
    expect(container.textContent).toContain("No plugins yet.");
  });
});
