// @vitest-environment jsdom

import {
  CommandId,
  PLUGIN_CATALOG,
  type PluginDirectoryResult,
  type PluginInstallPreview,
  type PluginListResult,
  type PluginSummary,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { pluginMatches } from "./PluginGallery.js";
import { PluginsSection, type PluginsView } from "./PluginsSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

type Command = { type: string } & Record<string, unknown>;
type Handler = (command: Command) => unknown;

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

function hasButton(root: ParentNode, label: string): boolean {
  return [...root.querySelectorAll("button")].some(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
}

const noParts = { skills: [], mcpServers: [], prompts: [], actions: [], ignored: [] };

function plugin(name: string, extra: Partial<PluginSummary> = {}): PluginSummary {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: "Tools.",
    format: "claude",
    enabled: true,
    path: `/data/plugins/${name}`,
    source: `https://github.com/acme/${name}`,
    installedAt: "2025-01-01T00:00:00.000Z",
    components: noParts,
    config: [],
    configured: [],
    problems: [],
    origin: "other",
    sourceKind: "github",
    ...extra,
  };
}

function preview(name: string, components: PluginSummary["components"] = noParts): PluginInstallPreview {
  return {
    label: `acme/${name}`,
    candidates: [
      {
        name,
        displayName: name,
        description: "",
        format: "claude",
        path: ".",
        components,
        config: [],
        files: 2,
        bytes: 100,
        exists: false,
      },
    ],
    elsewhere: [],
  };
}

/** A bridge whose replies come from `handlers`, by command type. Unhandled commands reply with the list. */
async function mount(
  handlers: Record<string, Handler>,
  bridgeExtra: Partial<ZliBridge> = {},
  initialView: PluginsView = "installed",
) {
  const commands: Command[] = [];
  let list: PluginListResult = { plugins: [], pluginsPath: "/data/plugins" };
  const setList = (next: PluginListResult) => {
    list = next;
    return next;
  };
  const bridge = {
    runtime: {
      dispatch: async (request: { commandId: string; command: Command }) => {
        const { command } = request;
        if (command.type !== "plugins.contributions") commands.push(command);
        const handler = handlers[command.type];
        let reply: unknown;
        try {
          reply =
            command.type === "plugins.contributions"
              ? { prompts: [], actions: [] }
              : handler
                ? await handler(command)
                : list;
        } catch (error) {
          return {
            commandId: CommandId.parse(request.commandId),
            accepted: false as const,
            error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
          };
        }
        return { commandId: CommandId.parse(request.commandId), accepted: true as const, result: reply };
      },
      getProjection: async () => undefined,
      onProjection: () => () => undefined,
    },
    ...bridgeExtra,
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (view: PluginsView, query = "") =>
    act(async () => {
      root.render(
        <RuntimeProvider bridge={bridge}>
          <PluginsSection view={view} query={query} />
        </RuntimeProvider>,
      );
    });
  await show(initialView);
  return { container, commands, setList, list: () => list, show };
}

const figma = PLUGIN_CATALOG.find((entry) => entry.id === "figma");
if (!figma) throw new Error("The catalog has no figma entry.");

describe("plugin gallery", () => {
  it("matches every search word against the name, publisher, and category", () => {
    const entry = {
      name: "figma",
      title: "Figma",
      description: "Designs to code.",
      publisher: "Figma",
      category: "design",
    };
    expect(pluginMatches(entry, "figma design")).toBe(true);
    expect(pluginMatches(entry, "stripe")).toBe(false);
  });

  it("installs a catalog plugin through the preview and marks it picked by ZLI", async () => {
    let installed = false;
    const listed = () => ({
      plugins: installed ? [plugin("figma", { origin: "zli-catalog" })] : [],
      pluginsPath: "/p",
    });
    const { container, commands, show } = await mount(
      {
        "plugins.list": listed,
        "plugins.checkUpdates": listed,
        "plugins.previewInstall": () =>
          preview("figma", {
            ...noParts,
            mcpServers: ["figma"],
            actions: [{ name: "Sync", description: "", command: "x" }],
          }),
        "plugins.install": () => {
          installed = true;
          return { plugins: [plugin("figma", { origin: "zli-catalog" })], pluginsPath: "/p", installed: ["figma"] };
        },
      },
      {},
      "browse",
    );
    expect(commands.map((command) => command.type)).toEqual(["plugins.list"]);
    const card = container.querySelector('[data-entry="figma"]') as HTMLElement;
    expect(card.textContent).toContain("Figma");
    expect(card.textContent).toContain(figma.publisher);

    expect(card.querySelector(".connector-logo svg")).not.toBeNull();
    expect(container.querySelector('[data-entry="code-review"] .connector-logo svg')).not.toBeNull();

    await show("browse", "zzz");
    expect(container.textContent).toContain("No plugins match.");
    await show("browse", "design");
    expect(container.querySelector('[data-entry="code-review"]')).toBeNull();
    expect(container.querySelector('[data-entry="figma"]')).not.toBeNull();

    await act(async () =>
      button(container.querySelector('[data-entry="figma"]') as HTMLElement, "Install Figma").click(),
    );
    expect(commands.at(-1)).toEqual({ type: "plugins.previewInstall", source: figma.source });
    const form = container.querySelector('form[aria-label="Install a plugin"]') as HTMLFormElement;
    expect(container.querySelector('[data-entry="figma"]')?.contains(form)).toBe(true);
    expect(form.querySelector("input.input")).toBeNull();
    expect(form.querySelector("legend")?.textContent).toContain("Picked by ZLI");
    expect(form.textContent).not.toContain("This plugin can run commands");

    await act(async () => button(form, "Install 1 plugin").click());
    expect(commands.at(-1)).toEqual({
      type: "plugins.install",
      source: figma.source,
      names: ["figma"],
      origin: "zli-catalog",
    });
    expect(container.querySelector('[data-entry="figma"]')?.textContent).toContain("Installed");
    expect(hasButton(container, "Install Figma")).toBe(false);
    const installedCard = container.querySelector('[data-entry="figma"]') as HTMLElement;
    expect(installedCard.querySelector('[role="status"]')?.textContent).toBe("Installed");
    expect(container.querySelector('form[aria-label="Install a plugin"]')).toBeNull();

    await show("installed");
    expect(container.querySelector(".plugin-row")?.textContent).toContain("Picked by ZLI");
    expect(container.querySelector(".plugin-row .connector-logo svg")).not.toBeNull();
  });

  it("loads Anthropic's directory on request, pages it, and installs from it", async () => {
    let fail = true;
    let release: () => void = () => undefined;
    const entries: PluginDirectoryResult["entries"] = [
      ...Array.from({ length: 34 }, (_, index) => ({
        name: `tool-${index}`,
        title: `Tool ${index}`,
        description: "Does things.",
        source: `https://github.com/acme/tools/tree/HEAD/tool-${index}`,
      })),
      { name: "lsp-only", title: "LSP only", description: "", unsupported: "It only adds a language server." },
    ];
    const { container, commands, show } = await mount(
      {
        "plugins.directory": async () => {
          if (fail) {
            fail = false;
            throw new Error("ZLI could not reach the plugin directory.");
          }
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { entries, fetchedAt: "2025-01-01T00:00:00.000Z" };
        },
        "plugins.previewInstall": (command) => preview(String(command.source).split("/").at(-1) ?? ""),
      },
      {},
      "browse",
    );
    await act(async () => button(container, "Search Anthropic's plugin directory").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not reach");

    await act(async () => button(container, "Try again").click());
    expect(container.textContent).toContain("Loading Anthropic's plugin directory");
    await act(async () => release());
    const directory = container.querySelector('[aria-label="Anthropic\'s plugin directory"]') as HTMLElement;
    expect(directory.textContent).toContain("35 plugins. ZLI has not checked these.");
    expect(directory.querySelectorAll(".connector-card")).toHaveLength(30);
    await act(async () => button(directory, "Show more").click());
    expect(directory.querySelectorAll(".connector-card")).toHaveLength(35);
    expect(hasButton(directory, "Show more")).toBe(false);

    const unsupported = directory.querySelector('[data-entry="directory:lsp-only"]') as HTMLElement;
    expect(unsupported.textContent).toContain("It only adds a language server.");
    expect(unsupported.querySelector("button")).toBeNull();

    await show("browse", "tool 12");
    const filtered = container.querySelector('[aria-label="Anthropic\'s plugin directory"]') as HTMLElement;
    expect(filtered.textContent).toContain("1 of 35 plugins match.");
    expect(filtered.querySelectorAll(".connector-card")).toHaveLength(1);
    await act(async () => button(filtered, "Install Tool 12").click());
    expect(commands.at(-1)).toEqual({
      type: "plugins.previewInstall",
      source: "https://github.com/acme/tools/tree/HEAD/tool-12",
    });
    const form = container.querySelector('form[aria-label="Install a plugin"]') as HTMLFormElement;
    expect(form.querySelector("legend")?.textContent).toContain("Anthropic directory");
    await act(async () => button(form, "Install 1 plugin").click());
    expect(commands.at(-1)).toMatchObject({
      type: "plugins.install",
      names: ["tool-12"],
      origin: "anthropic-directory",
    });
  });
});

describe("plugin updates and origins", () => {
  it("checks for updates in the background and offers Update, Reload from folder, or nothing", async () => {
    const kit = plugin("kit", { commit: "a".repeat(40) });
    const local = plugin("local", { sourceKind: "local", source: "/home/me/local", origin: "other" });
    const pinned = plugin("pinned", { pinned: true, origin: "anthropic-directory", updateAvailable: false });
    const { container, commands } = await mount({
      "plugins.list": () => ({ plugins: [kit, local, pinned], pluginsPath: "/p" }),
      "plugins.checkUpdates": () => ({
        plugins: [{ ...kit, updateAvailable: true, checkedAt: "2025-01-01T00:00:00.000Z" }, local, pinned],
        pluginsPath: "/p",
        problem: "GitHub limited update checks. Try again later.",
      }),
      "plugins.update": () => ({ plugins: [{ ...kit, updateAvailable: false }, local, pinned], pluginsPath: "/p" }),
    });
    const rows = () => [...container.querySelectorAll<HTMLElement>(".plugin-row")];
    const [kitRow, localRow, pinnedRow] = rows();
    expect(kitRow?.textContent).toContain("Update available");
    expect(kitRow?.textContent).toContain("Unknown source");
    expect(kitRow?.querySelector(".badge-warning")?.getAttribute("title")).toBe(
      "ZLI did not check this plugin. Install plugins only from people you trust.",
    );
    expect(localRow?.textContent).toContain("Reload from folder");
    expect(pinnedRow?.textContent).toContain("Anthropic directory");
    expect(hasButton(pinnedRow as HTMLElement, "Update Pinned")).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("GitHub limited update checks. Try again later.");

    await act(async () => button(kitRow as HTMLElement, "Update Kit").click());
    expect(commands.at(-1)).toEqual({ type: "plugins.update", name: "kit" });
    expect(rows()[0]?.textContent).not.toContain("Update available");
    expect(hasButton(rows()[0] as HTMLElement, "Update Kit")).toBe(false);

    await act(async () => button(rows()[1] as HTMLElement, "Reload Local from its folder").click());
    expect(commands.at(-1)).toEqual({ type: "plugins.update", name: "local" });
  });

  it("warns before installing a plugin from an unknown source that can run commands", async () => {
    const { container, commands } = await mount(
      {
        "plugins.previewInstall": () =>
          preview("kit", { ...noParts, actions: [{ name: "Test", description: "", command: "npm test" }] }),
      },
      {},
      "custom",
    );
    await act(async () => button(container, "Install plugin").click());
    const form = container.querySelector('form[aria-label="Install a plugin"]') as HTMLFormElement;
    await act(async () => setValue(form.querySelector("input") as HTMLInputElement, "acme/kit"));
    await act(async () => form.requestSubmit());
    expect(form.querySelector("legend")?.textContent).toContain("Unknown source");
    expect(form.textContent).toContain(
      "This plugin can run commands on your computer. Install it only if you trust where it came from.",
    );
    await act(async () => button(form, "Install 1 plugin").click());
    expect(commands.at(-1)).toEqual({ type: "plugins.install", source: "acme/kit", names: ["kit"] });
  });
});

describe("Share my setup", () => {
  it("lists the person's skills and servers, checks the name, and saves to the chosen folder", async () => {
    const { container, commands } = await mount(
      {
        "skills.list": () => ({
          skills: [
            { name: "helper", description: "Helps.", scope: "user", enabled: true, path: "/lib/helper" },
            { name: "repo-only", description: "", scope: "project", enabled: true, path: "/repo/x" },
          ],
          found: [],
          libraryPath: "/lib",
          sync: { enabled: true, outcomes: [] },
        }),
        "mcp.list": () => ({
          servers: [
            {
              name: "docs",
              enabled: true,
              transport: "http",
              url: "https://docs.example/mcp",
              headers: {},
              oauth: false,
            },
            { name: "local", enabled: true, transport: "stdio", command: "run", args: [], env: {} },
          ],
          agentAccess: "full",
          signIns: [],
          health: [],
        }),
        "plugins.export": (command) => ({ folder: command.folder, files: [".claude-plugin/plugin.json"] }),
      },
      { dialog: { openProject: async () => "/home/me/my-setup" } } as Partial<ZliBridge>,
      "custom",
    );
    await act(async () => button(container, "Share my setup").click());
    const form = container.querySelector('form[aria-label="Share my setup"]') as HTMLFormElement;
    expect(form.textContent).toContain("helper");
    expect(form.textContent).not.toContain("repo-only");
    expect(form.textContent).toContain("docs");
    expect(form.textContent).toContain(
      "Environment variables and headers are not copied. People who install it add their own. Commands, args, and URLs are copied as they are, so take any secrets out of them first.",
    );

    const [nameInput] = form.querySelectorAll<HTMLInputElement>("input.input");
    await act(async () => setValue(nameInput as HTMLInputElement, "My Setup"));
    await act(async () => form.requestSubmit());
    expect(form.querySelector('[role="alert"]')?.textContent).toContain("lowercase letters");
    expect(commands.some((command) => command.type === "plugins.export")).toBe(false);

    await act(async () => setValue(nameInput as HTMLInputElement, "my-setup"));
    const box = (label: string) =>
      [...form.querySelectorAll("label")].find((entry) => entry.textContent?.startsWith(label))?.querySelector("input");
    await act(async () => box("helper")?.click());
    await act(async () => box("docs")?.click());
    await act(async () => button(form, "Choose a folder").click());
    const folder = [...form.querySelectorAll<HTMLInputElement>("input.input")].at(-1);
    expect(folder?.value).toBe("/home/me/my-setup");
    await act(async () => form.requestSubmit());
    expect(commands.at(-1)).toEqual({
      type: "plugins.export",
      folder: "/home/me/my-setup",
      name: "my-setup",
      skills: ["helper"],
      servers: ["docs"],
    });
    expect(container.querySelector('form[aria-label="Share my setup"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved to /home/me/my-setup.");
  });
});
