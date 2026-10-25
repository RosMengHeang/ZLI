// @vitest-environment jsdom

import { CommandId, type PluginInstallPreview, type PluginListResult, type PluginSummary } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { combinePrompts } from "../prompts/prompts.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { PluginsSection } from "../settings/PluginsSection.js";
import { PluginActionDialog } from "./PluginActionDialog.js";
import {
  ACTION_APPROVALS_KEY,
  actionApprovalKey,
  actionTerminalCommand,
  componentSummary,
  isActionApproved,
  originForSource,
  parseActionApprovals,
  rememberActionApproval,
} from "./plugins.js";

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

describe("plugin action approvals", () => {
  const action = { plugin: "kit", name: "Test", description: "", command: "npm test" };

  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      values,
    };
  }

  it("hashes the plugin, action, and command, so a changed command asks again", async () => {
    const key = await actionApprovalKey(action);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(await actionApprovalKey({ ...action })).toBe(key);
    expect(await actionApprovalKey({ ...action, command: "npm test && curl x" })).not.toBe(key);
    expect(await actionApprovalKey({ ...action, plugin: "other" })).not.toBe(key);
    expect(await actionApprovalKey({ ...action, name: "Build" })).not.toBe(key);
  });

  it("remembers approvals without storing the command", async () => {
    const storage = memoryStorage();
    const key = (await actionApprovalKey(action)) as string;
    expect(isActionApproved(key, storage)).toBe(false);
    rememberActionApproval(key, storage);
    rememberActionApproval(key, storage);
    expect(isActionApproved(key, storage)).toBe(true);
    const stored = storage.values.get(ACTION_APPROVALS_KEY) ?? "";
    expect(JSON.parse(stored)).toEqual([key]);
    expect(stored).not.toContain("npm test");
    const changed = (await actionApprovalKey({ ...action, command: "rm -rf ~" })) as string;
    expect(isActionApproved(changed, storage)).toBe(false);
  });

  it("ignores stored values that are not approvals", () => {
    expect(parseActionApprovals(null)).toEqual([]);
    expect(parseActionApprovals("not json")).toEqual([]);
    expect(parseActionApprovals(JSON.stringify(["a".repeat(64), "short", 4]))).toEqual(["a".repeat(64)]);
  });

  it("treats catalog sources as picked by ZLI", () => {
    const source = "https://github.com/figma/mcp-server-guide/tree/main";
    expect(originForSource(source)).toBe("zli-catalog");
    expect(originForSource(`${source}/`, "other")).toBe("zli-catalog");
    expect(originForSource("acme/kit")).toBe("other");
    expect(originForSource("acme/kit", "anthropic-directory")).toBe("anthropic-directory");
  });
});

describe("PluginActionDialog", () => {
  it("shows the exact command and where the plugin came from, and remembers by default", async () => {
    const runs: boolean[] = [];
    let canceled = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (canRemember: boolean) =>
      act(async () => {
        root.render(
          <PluginActionDialog
            action={{ plugin: "kit", name: "Deploy", description: "", command: "npm run deploy -- --prod" }}
            pluginName="Kit"
            origin="other"
            canRemember={canRemember}
            onRun={(remember) => runs.push(remember)}
            onCancel={() => {
              canceled += 1;
            }}
          />,
        );
      });
    await render(true);
    expect(container.querySelector(".dialog-title")?.textContent).toBe("Run Deploy from Kit?");
    expect(container.querySelector("pre code")?.textContent).toBe("npm run deploy -- --prod");
    expect(container.textContent).toContain("Unknown source");
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(true);
    expect(box?.closest("label")?.textContent).toContain("Don't ask again for this command");
    expect(document.activeElement?.textContent).toBe("Cancel");

    await act(async () => button(container, "Run").click());
    await act(async () => box?.click());
    await act(async () => button(container, "Run").click());
    await act(async () => button(container, "Cancel").click());
    expect(runs).toEqual([true, false]);
    expect(canceled).toBe(1);

    await render(false);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
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
  origin: "other",
  sourceKind: "github",
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
    const root = createRoot(container);
    const show = (view: "installed" | "custom") =>
      act(async () => {
        root.render(
          <RuntimeProvider bridge={bridge}>
            <PluginsSection view={view} />
          </RuntimeProvider>,
        );
      });
    await show("installed");
    expect(container.textContent).toContain("No plugins yet.");

    await show("custom");
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
    expect(container.textContent).toContain("Installed Kit. It is listed in Installed.");

    await show("installed");
    expect(container.textContent).not.toContain("Add API token");
    expect(container.textContent).toContain("Left out, since only Claude Code or Codex runs them: hooks.");

    await act(async () => button(container, "Remove Kit").click());
    await act(async () => button(container, "Remove").click());
    expect(commands.at(-1)).toEqual({ type: "plugins.remove", name: "kit" });
    expect(container.textContent).toContain("No plugins yet.");
  });
});
