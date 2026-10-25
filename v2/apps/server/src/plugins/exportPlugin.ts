import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { McpServerConfig, PluginExportResult } from "@zli-v2/contracts";

import { isNotFound, skillFileList } from "../skills/skillFolders.js";
import { MAX_PLUGIN_BYTES, MAX_PLUGIN_FILE_BYTES, PluginError } from "./pluginPackage.js";

export type PluginExportRequest = {
  folder: string;
  name: string;
  displayName?: string | undefined;
  description?: string | undefined;
  skills: readonly string[];
  servers: readonly string[];
};

/** The person's own skills and MCP servers, which an export copies from. */
export type PluginExportSources = {
  skills: () => Promise<ReadonlyArray<{ name: string; path: string }>>;
  servers: () => readonly McpServerConfig[];
};

type ConfigEntry = { type: "string"; title: string; description: string; sensitive: true; required: true };

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

/**
 * Writes chosen skills and MCP servers as a Claude Code plugin that ZLI can install again. Secrets stay
 * behind: every environment and header value becomes a setting the person fills in when they install it.
 */
export async function exportPlugin(
  request: PluginExportRequest,
  sources: PluginExportSources,
): Promise<PluginExportResult> {
  const folder = request.folder.trim();
  if (!isAbsolute(folder)) throw new PluginError("Pick a folder with its full path.");
  const target = resolve(folder);
  if (!(await isEmptyFolder(target))) throw new PluginError("Pick an empty folder.");
  const skillNames = [...new Set(request.skills)];
  const serverNames = [...new Set(request.servers.map((name) => name.toLowerCase()))];
  if (skillNames.length + serverNames.length === 0) throw new PluginError("Pick at least one skill or MCP server.");

  const library = await sources.skills();
  const skills = skillNames.map((name) => {
    const found = library.find((skill) => skill.name === name);
    if (!found) throw new PluginError(`There is no skill named ${name}.`);
    return found;
  });
  const saved = sources.servers();
  const servers = serverNames.map((name) => {
    const found = saved.find((server) => server.name.toLowerCase() === name);
    if (!found) throw new PluginError(`There is no MCP server named ${name}.`);
    return found;
  });

  const files = new Map<string, string | Uint8Array>();
  let bytes = 0;
  for (const skill of skills) {
    for (const path of await skillFileList(skill.path)) {
      const data = await readFile(join(skill.path, ...path.split("/")));
      if (data.byteLength > MAX_PLUGIN_FILE_BYTES) {
        throw new PluginError(`Skill ${skill.name} has a file too large to export: ${path}.`);
      }
      bytes += data.byteLength;
      if (bytes > MAX_PLUGIN_BYTES) throw new PluginError("The chosen skills are too large to export together.");
      files.set(`skills/${skill.name}/${path}`, data);
    }
  }

  const userConfig: Record<string, ConfigEntry> = {};
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) mcpServers[server.name] = exportServer(server, userConfig);

  const description =
    request.description?.trim() ||
    `${describeParts(skills.length, servers.length)} exported from ZLI.`.replace(/^./u, (char) => char.toUpperCase());
  const manifest = {
    name: request.name,
    ...(request.displayName?.trim() ? { displayName: request.displayName.trim() } : {}),
    description,
    version: "0.1.0",
    ...(Object.keys(userConfig).length > 0 ? { userConfig } : {}),
  };
  files.set(".claude-plugin/plugin.json", `${JSON.stringify(manifest, null, 2)}\n`);
  if (servers.length > 0) files.set(".mcp.json", `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  files.set(
    "README.md",
    readme({
      title: request.displayName?.trim() || request.name,
      description,
      skills: skills.map((skill) => skill.name),
      servers,
      settings: Object.values(userConfig).map((entry) => entry.title),
    }),
  );

  try {
    await mkdir(target, { recursive: true });
    for (const [path, data] of files) {
      const file = join(target, ...path.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data, { flag: "wx" });
    }
  } catch (error) {
    throw new PluginError(
      `ZLI could not write the plugin to that folder. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { folder: target, files: [...files.keys()].sort((left, right) => left.localeCompare(right)) };
}

/** One server in `.mcp.json` form, with each value replaced by a `user_config` placeholder. */
function exportServer(server: McpServerConfig, userConfig: Record<string, ConfigEntry>): Record<string, unknown> {
  const placeholders = (values: Readonly<Record<string, string>>, kind: "variable" | "header") =>
    Object.fromEntries(
      Object.keys(values).map((name) => {
        const key = uniqueKey(`${server.name}_${name}`.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 90), userConfig);
        userConfig[key] = {
          type: "string",
          title: `${name} for ${server.name}`,
          description:
            kind === "variable"
              ? `The ${name} environment variable for the ${server.name} MCP server.`
              : `The ${name} header sent to the ${server.name} MCP server.`,
          sensitive: true,
          required: true,
        };
        return [name, `\${user_config.${key}}`];
      }),
    );
  if (server.transport === "http") {
    if (server.oauth) return { type: "http", url: server.url };
    const headers = placeholders(server.headers, "header");
    return { type: "http", url: server.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  const env = placeholders(server.env, "variable");
  return {
    command: server.command,
    ...(server.args.length > 0 ? { args: server.args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function uniqueKey(base: string, taken: Readonly<Record<string, unknown>>): string {
  let key = base;
  for (let index = 2; key in taken; index += 1) key = `${base}_${index}`;
  return key;
}

function describeParts(skills: number, servers: number): string {
  const parts = [
    ...(skills > 0 ? [`${skills} ${skills === 1 ? "skill" : "skills"}`] : []),
    ...(servers > 0 ? [`${servers} MCP ${servers === 1 ? "server" : "servers"}`] : []),
  ];
  return parts.join(" and ");
}

function readme(input: {
  title: string;
  description: string;
  skills: readonly string[];
  servers: readonly McpServerConfig[];
  settings: readonly string[];
}): string {
  const lines = [`# ${input.title}`, "", input.description, "", "## What is inside", ""];
  if (input.skills.length > 0) lines.push(`- Skills: ${input.skills.join(", ")}`);
  for (const server of input.servers) {
    const how =
      server.transport === "http"
        ? server.oauth
          ? "a remote server you sign in to"
          : "a remote server"
        : `a local server started with \`${server.command}\``;
    lines.push(`- MCP server ${server.name}: ${how}`);
  }
  if (input.settings.length > 0) {
    lines.push(
      "",
      "## Settings",
      "",
      "Secrets were left out. You fill these in when you install the plugin:",
      "",
      ...input.settings.map((title) => `- ${title}`),
    );
  }
  lines.push(
    "",
    "## Install in ZLI",
    "",
    "Open Settings, Plugins, Install plugin, then pick this folder.",
    "",
    "It also works as a Claude Code plugin.",
    "",
  );
  return lines.join("\n");
}

async function isEmptyFolder(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return false;
  } catch (error) {
    return isNotFound(error);
  }
  const entries = await readdir(path).catch(() => undefined);
  return entries?.every((name) => IGNORED_FILES.has(name)) === true;
}
