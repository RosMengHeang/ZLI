import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  catalogServer,
  type ListedProviderKind,
  MCP_CATALOG,
  type McpCatalogEntry,
  type McpServerConfig,
} from "@zli-v2/contracts";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isHttpSpec, type McpServerSpec } from "../browser-tool/browserTool.js";
import { projectMcpFile } from "../browser-tool/mcpSettingsFiles.js";
import { createDefaultCliProbe, discoverCliProviders } from "../providers/discoverCliProviders.js";
import { agentMcpLaunch } from "../terminal/agentLaunch.js";
import { readableTerminalText } from "../terminal/terminalText.js";
import { WorktreeAgentFiles } from "../worktrees/WorktreeAgentFiles.js";
import { type McpProbeOutcome, probeMcpServer } from "./McpProbe.js";
import { McpServerStore } from "./McpServerStore.js";
import type { McpSignIns } from "./signIn/McpSignIns.js";

/**
 * Starts every agent CLI ZLI supports against every connector in ZLI's catalog, plus three local test
 * servers, and checks that each agent is handed every connector and that the test servers load tools.
 * Real connectors are not signed in, so whether they answer is reported but not asserted.
 *
 *   ZLI_RUN_AGENT_CLIS=1 pnpm exec vitest run apps/server/src/mcp/agentConnectors.cli.test.ts
 *
 * Agent CLIs that are not installed are skipped. ZLI_AGENT_REPORT sets where the Markdown report goes.
 */
const RUN = process.env.ZLI_RUN_AGENT_CLIS === "1";
const V2_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const REPORT_PATH = process.env.ZLI_AGENT_REPORT ?? join(tmpdir(), "zli-agent-connectors.md");
const CLI_TIMEOUT_MS = 6 * 60_000;

const AGENTS: readonly ListedProviderKind[] = [
  "codex",
  "claude-code",
  "cursor-agent",
  "droid",
  "opencode",
  "gemini",
  "copilot",
  "kimi",
  "qwen",
  "goose",
];

const FIXTURE_TOKEN = { signIn: "zli-check-signin-token", header: "zli-check-header-token" };
const FIXTURE_TOOLS: Record<string, string> = {
  "zli-check-local": "zli_check_local_ping",
  "zli-check-signin": "zli_check_signin_ping",
  "zli-check-token": "zli_check_token_ping",
};

type Entry =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> };

type CliStatus = "connected" | "not connected" | "still starting" | "disabled" | "listed";

type AgentResult = {
  installed: boolean;
  /** Each server as the agent receives it, read back from its flags, config file, environment, or project MCP file. */
  entries: Map<string, Entry>;
  /** Each server as the agent's own `mcp list` reports it. Undefined when the CLI has no such command. */
  listed?: Map<string, CliStatus>;
  listOutput?: string;
  /** Tools the agent's own CLI reports for the test servers, where it can list them. */
  cliTools?: Map<string, string[]>;
  /** The test servers, started from the entry this agent received. */
  fixtureProbes: Map<string, McpProbeOutcome>;
  problems: string[];
};

describe.skipIf(!RUN)("agent CLIs find the connectors ZLI hands them", () => {
  let root = "";
  let home = "";
  let project = "";
  let fixture: Server | undefined;
  let specs: McpServerSpec[] = [];
  let names: string[] = [];
  let expected: ReadonlyMap<string, Entry> = new Map();
  const results = new Map<ListedProviderKind, AgentResult>();
  const reachability = new Map<string, McpProbeOutcome>();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "zli-agent-connectors-"));
    home = join(root, "home");
    project = join(home, "project");
    await mkdir(project, { recursive: true });
    await run("git", ["init", "-q"], { cwd: project, env: cliEnv(home, {}) });
    const connectScript = join(root, "zli-connect.js");
    await build({
      entryPoints: [join(V2_ROOT, "apps/server/src/connect-entry.ts")],
      outfile: connectScript,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      logLevel: "silent",
    });
    const localScript = join(root, "local-server.mjs");
    await writeFile(localScript, LOCAL_SERVER);
    const base = await startFixture((server) => {
      fixture = server;
    });
    const signInFile = join(root, "sign-ins", "zli-check-signin.json");
    await mkdir(join(root, "sign-ins"), { recursive: true });
    await writeFile(
      signInFile,
      JSON.stringify({
        version: 1,
        serverUrl: `${base}/signin`,
        via: "browser",
        accessToken: FIXTURE_TOKEN.signIn,
        signedInAt: new Date().toISOString(),
      }),
    );

    const fixtures: McpServerConfig[] = [
      {
        name: "zli-check-local",
        enabled: true,
        command: process.execPath,
        args: [localScript],
        env: { ZLI_CHECK: "1" },
      },
      { name: "zli-check-signin", enabled: true, transport: "http", url: `${base}/signin`, headers: {}, oauth: true },
      {
        name: "zli-check-token",
        enabled: true,
        transport: "http",
        url: `${base}/token`,
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN.header}` },
        oauth: false,
      },
    ];
    const files = join(root, "files");
    await mkdir(files, { recursive: true });
    const catalog = MCP_CATALOG.map((entry) => catalogServer(entry, fieldValues(entry, files)));
    const signIns = {
      tokenFile: (url: string) =>
        url === `${base}/signin` ? signInFile : join(root, "sign-ins", `${encodeURIComponent(url)}.json`),
      accessToken: () => undefined,
      status: () => ({ signedIn: false }),
      load: async () => undefined,
      reload: async () => undefined,
    } as unknown as McpSignIns;
    const store = new McpServerStore({
      path: join(root, "zli", "mcp-servers.json"),
      connectTool: { command: process.execPath, script: connectScript },
      signIns,
    });
    await store.load();
    await store.save([...fixtures, ...catalog]);
    specs = store.specs({ projectPath: project });
    names = specs.map((spec) => spec.name);
    expected = new Map(specs.map((spec) => [spec.name, entryOf(spec)]));

    const found = new Map(
      (await discoverCliProviders(createDefaultCliProbe(), { models: false })).flatMap((entry) =>
        entry.status === "found" ? [[entry.provider, entry.path] as const] : [],
      ),
    );

    const agentFiles = new WorktreeAgentFiles({ statePath: join(root, "zli", "worktree-files.json") });

    // Warms the npx cache too, so the agents' own connection checks do not each download the packages.
    await inPool(specs, 6, async (spec) => {
      reachability.set(spec.name, await probeMcpServer(specConfig(spec.name, entryOf(spec)), { timeoutMs: 90_000 }));
    });

    await Promise.all(
      AGENTS.map(async (provider) => {
        const command = found.get(provider);
        const result: AgentResult = {
          installed: command !== undefined,
          entries: new Map(),
          fixtureProbes: new Map(),
          problems: [],
        };
        results.set(provider, result);
        if (!command) return;
        const launch = await agentMcpLaunch(provider, specs, {
          configDir: join(root, "zli", "mcp"),
          worktreeId: "zli-check",
          worktreePath: project,
          writeWorktreeFile: (worktreePath, relPath, contents) => agentFiles.writeFile(worktreePath, relPath, contents),
          env: {},
        });
        const env = cliEnv(home, launch.env);
        try {
          result.entries = await readBack(provider, { command, args: launch.args, env, project }, expected);
        } catch (error) {
          result.problems.push(`Could not read what ${provider} received: ${String(error)}`);
        }
        try {
          await listWithCli(provider, result, { command, args: launch.args, env, project }, new Set(names));
        } catch (error) {
          result.problems.push(`${provider}'s own MCP list failed: ${String(error)}`);
        }
        for (const name of Object.keys(FIXTURE_TOOLS)) {
          const entry = result.entries.get(name);
          if (entry) result.fixtureProbes.set(name, await probeMcpServer(specConfig(name, entry)));
        }
      }),
    );
  }, 20 * 60_000);

  afterAll(async () => {
    if (specs.length > 0) {
      await writeFile(REPORT_PATH, report(names, results, reachability, expected));
      console.log(`Agent connector report: ${REPORT_PATH}`);
    }
    await new Promise<void>((done) => (fixture ? fixture.close(() => done()) : done()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("hands every catalog connector to the agents", () => {
    expect(names).toEqual(expect.arrayContaining(MCP_CATALOG.map((entry) => entry.id)));
    expect(names).toEqual(expect.arrayContaining(Object.keys(FIXTURE_TOOLS)));
  });

  for (const provider of AGENTS) {
    describe(provider, () => {
      const installed = () => results.get(provider)?.installed === true;

      it("receives every connector exactly as ZLI saved it", (context) => {
        if (!installed()) context.skip();
        const result = results.get(provider);
        expect(result?.problems ?? []).toEqual([]);
        for (const spec of specs) {
          expect(result?.entries.get(spec.name), `${spec.name} as ${provider} receives it`).toEqual(entryOf(spec));
        }
      });

      it("loads the tools of the test servers from what it received", (context) => {
        if (!installed()) context.skip();
        const result = results.get(provider);
        for (const [name, tool] of Object.entries(FIXTURE_TOOLS)) {
          const outcome = result?.fixtureProbes.get(name);
          expect(outcome?.problem, `${name} through ${provider}`).toBeUndefined();
          expect(outcome?.tools.map((entry) => entry.name)).toContain(tool);
        }
      });

      it("lists every connector with its own MCP command", (context) => {
        const result = results.get(provider);
        if (!installed() || !result?.listed) context.skip();
        for (const name of names) {
          expect(result?.listed?.has(name), `${provider} mcp list shows ${name}\n${result?.listOutput}`).toBe(true);
        }
        if (provider === "codex") return;
        for (const name of Object.keys(FIXTURE_TOOLS)) {
          expect(result?.listed?.get(name), `${provider} connects to ${name}\n${result?.listOutput}`).toBe("connected");
        }
        for (const [name, tools] of result?.cliTools ?? []) expect(tools).toContain(FIXTURE_TOOLS[name]);
      });
    });
  }
});

/** Values for the fields a catalog entry needs before it can be added. */
function fieldValues(entry: McpCatalogEntry, folder: string): Record<string, string> {
  return Object.fromEntries(
    entry.fields
      .filter((field) => !field.optional)
      .map((field) => [field.key, field.key === "folder" ? folder : "zli-check-placeholder"]),
  );
}

function entryOf(spec: McpServerSpec): Entry {
  return isHttpSpec(spec)
    ? { kind: "http", url: spec.url, headers: { ...spec.headers } }
    : { kind: "stdio", command: spec.command, args: [...spec.args], env: { ...spec.env } };
}

function specConfig(name: string, entry: Entry): McpServerConfig {
  return entry.kind === "http"
    ? { name, enabled: true, transport: "http", url: entry.url, headers: entry.headers, oauth: false }
    : { name, enabled: true, command: entry.command, args: entry.args, env: entry.env };
}

/** A clean environment with HOME moved, so no agent reads or writes the real user's settings. */
function cliEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    npm_config_cache: process.env.npm_config_cache ?? join(homedir(), ".npm"),
    ...extra,
  };
}

type CliContext = { command: string; args: string[]; env: NodeJS.ProcessEnv; project: string };

async function readBack(
  provider: ListedProviderKind,
  context: CliContext,
  expected: ReadonlyMap<string, Entry>,
): Promise<Map<string, Entry>> {
  switch (provider) {
    case "codex": {
      const { stdout } = await run(context.command, [...context.args, "mcp", "list", "--json"], {
        cwd: context.project,
        env: context.env,
      });
      return codexEntries(JSON.parse(stdout) as unknown[]);
    }
    case "claude-code":
    case "copilot": {
      const flag = provider === "claude-code" ? "--mcp-config" : "--additional-mcp-config";
      const value = context.args[context.args.indexOf(flag) + 1];
      if (!value) throw new Error(`No ${flag} flag.`);
      return settingsEntries(JSON.parse(await readFile(value.replace(/^@/u, ""), "utf8")));
    }
    case "opencode":
      return opencodeEntries(JSON.parse(context.env.OPENCODE_CONFIG_CONTENT ?? "{}"));
    case "goose":
      return gooseEntries(context.args, expected);
    case "cursor-agent":
    case "droid":
    case "gemini":
    case "kimi":
    case "qwen": {
      const file = projectMcpFile(provider);
      if (!file) throw new Error("No project MCP file.");
      return settingsEntries(JSON.parse(await readFile(join(context.project, ...file.split("/")), "utf8")));
    }
  }
}

function settingsEntries(parsed: unknown): Map<string, Entry> {
  const servers = record(record(parsed).mcpServers);
  const entries = new Map<string, Entry>();
  for (const [name, raw] of Object.entries(servers)) {
    const server = record(raw);
    const url = server.url ?? server.httpUrl;
    entries.set(
      name,
      typeof url === "string"
        ? { kind: "http", url, headers: strings(server.headers) }
        : {
            kind: "stdio",
            command: String(server.command),
            args: Array.isArray(server.args) ? server.args.map(String) : [],
            env: strings(server.env),
          },
    );
  }
  return entries;
}

function codexEntries(list: unknown[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const raw of list) {
    const server = record(raw);
    const transport = record(server.transport);
    entries.set(
      String(server.name),
      transport.type === "streamable_http"
        ? { kind: "http", url: String(transport.url), headers: strings(transport.http_headers) }
        : {
            kind: "stdio",
            command: String(transport.command),
            args: Array.isArray(transport.args) ? transport.args.map(String) : [],
            env: strings(transport.env),
          },
    );
  }
  return entries;
}

function opencodeEntries(parsed: unknown): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const [name, raw] of Object.entries(record(record(parsed).mcp))) {
    const server = record(raw);
    if (server.type === "remote") {
      entries.set(name, { kind: "http", url: String(server.url), headers: strings(server.headers) });
      continue;
    }
    const [command = "", ...args] = Array.isArray(server.command) ? server.command.map(String) : [];
    entries.set(name, { kind: "stdio", command, args, env: strings(server.environment) });
  }
  return entries;
}

/** Goose extensions carry no name, so each one is matched to the server with the same command line or URL. */
function gooseEntries(args: readonly string[], expected: ReadonlyMap<string, Entry>): Map<string, Entry> {
  const found: Entry[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1] ?? "";
    if (args[index] === "--with-streamable-http-extension") found.push({ kind: "http", url: value, headers: {} });
    if (args[index] !== "--with-extension") continue;
    const words = shellWords(value);
    const env: Record<string, string> = {};
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) {
      const word = words.shift() ?? "";
      env[word.slice(0, word.indexOf("="))] = word.slice(word.indexOf("=") + 1);
    }
    const [command = "", ...rest] = words;
    found.push({ kind: "stdio", command, args: rest, env });
  }
  const entries = new Map<string, Entry>();
  for (const entry of found) {
    const key = JSON.stringify(entry.kind === "http" ? [entry.url] : [entry.command, entry.args]);
    for (const [name, wanted] of expected) {
      const wantedKey = JSON.stringify(wanted.kind === "http" ? [wanted.url] : [wanted.command, wanted.args]);
      if (wantedKey === key && !entries.has(name)) entries.set(name, entry);
    }
  }
  return entries;
}

function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quoted) {
      if (char === "'") quoted = false;
      else word += char;
    } else if (char === "'") {
      quoted = true;
      started = true;
    } else if (char === "\\") {
      word += line[index + 1] ?? "";
      index += 1;
      started = true;
    } else if (char === " ") {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** Runs the agent's own MCP list command where it has one that sees the servers ZLI hands it. */
async function listWithCli(
  provider: ListedProviderKind,
  result: AgentResult,
  context: CliContext,
  names: ReadonlySet<string>,
): Promise<void> {
  // Some CLIs, Gemini among them, print the list on stderr.
  const exec = async (args: string[], env: NodeJS.ProcessEnv = context.env) => {
    const { stdout, stderr } = await run(context.command, args, { cwd: context.project, env, timeout: CLI_TIMEOUT_MS });
    return `${stdout}\n${stderr}`;
  };
  let output: string;
  switch (provider) {
    case "codex":
      result.listed = new Map([...result.entries.keys()].map((name) => [name, "listed"]));
      return;
    case "cursor-agent":
      output = await exec(["mcp", "list"]);
      result.cliTools = new Map();
      for (const name of Object.keys(FIXTURE_TOOLS)) {
        const tools = await exec(["mcp", "list-tools", name]);
        result.cliTools.set(
          name,
          [...tools.matchAll(/^- (\S+) \(/gmu)].map((match) => match[1] ?? ""),
        );
      }
      break;
    case "droid":
    case "opencode":
    case "qwen":
      output = await exec(["mcp", "list"]);
      break;
    case "gemini":
      // `mcp list` cannot take --skip-trust, which only applies to a session; this variable trusts the folder the same way.
      output = await exec(["mcp", "list"], { ...context.env, GEMINI_CLI_TRUST_WORKSPACE: "true" });
      break;
    default:
      return;
  }
  output = readableTerminalText(output, 10_000).text;
  result.listOutput = output;
  result.listed = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const words = line.trim().split(/\s+/u);
    const index = words.findIndex((word) => names.has(word.replace(/:$/u, "")));
    if (index < 0) continue;
    // A later line, such as a printed command line, can repeat the name; the status line comes first.
    const name = words[index]?.replace(/:$/u, "") ?? "";
    if (!result.listed.has(name)) result.listed.set(name, cliStatus(line));
  }
}

function cliStatus(line: string): CliStatus {
  if (/disconnected|failed|error|✗/iu.test(line)) return "not connected";
  if (/connecting|pending|starting/iu.test(line)) return "still starting";
  if (/disabled/iu.test(line)) return "disabled";
  if (/connected|ready/iu.test(line)) return "connected";
  return "listed";
}

function report(
  servers: readonly string[],
  results: ReadonlyMap<ListedProviderKind, AgentResult>,
  reachability: ReadonlyMap<string, McpProbeOutcome>,
  expected: ReadonlyMap<string, Entry>,
): string {
  const agents = AGENTS.filter((provider) => results.get(provider)?.installed);
  const missing = AGENTS.filter((provider) => !results.get(provider)?.installed);
  const lines = [
    "# Connectors in each agent",
    "",
    `Agents checked: ${agents.join(", ") || "none"}.`,
    ...(missing.length > 0 ? [`Not installed, skipped: ${missing.join(", ")}.`] : []),
    "",
    "Each agent cell says whether the agent received the connector as ZLI saved it, then what the agent's own",
    "`mcp list` reported when it has one. The second column is a direct connection test without signing in.",
    "",
    `| Connector | Without sign-in | ${agents.join(" | ")} |`,
    `| --- | --- | ${agents.map(() => "---").join(" | ")} |`,
  ];
  for (const name of servers) {
    const cells = agents.map((provider) => {
      const result = results.get(provider);
      const received = result?.entries.get(name);
      if (!received) return "missing";
      if (JSON.stringify(received) !== JSON.stringify(expected.get(name))) return "wrong config";
      const listed = result?.listed?.get(name);
      return listed ? `received, ${listed}` : "received";
    });
    lines.push(`| ${name} | ${reachText(reachability.get(name))} | ${cells.join(" | ")} |`);
  }
  const problems = agents.flatMap((provider) => results.get(provider)?.problems ?? []);
  if (problems.length > 0) lines.push("", "## Problems", "", ...problems.map((problem) => `- ${problem}`));
  for (const provider of agents) {
    const output = results.get(provider)?.listOutput?.trim();
    if (output) lines.push("", `## ${provider} mcp list`, "", "```text", output, "```");
  }
  return `${lines.join("\n")}\n`;
}

function reachText(outcome: McpProbeOutcome | undefined): string {
  if (!outcome) return "not tested";
  if (outcome.ok) return `${outcome.tools.length} tools`;
  if (outcome.needsSignIn) return "needs sign-in";
  return (outcome.problem ?? "failed").replace(/\|/gu, "/").slice(0, 120);
}

async function inPool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeout ?? 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) fail(new Error(`${command} ${args.slice(-3).join(" ")} failed: ${error.message}\n${stderr}`));
        else done({ stdout, stderr });
      },
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, String(item)]));
}

/** Two remote test servers: one wants the saved sign-in token, the other the token in a header. */
async function startFixture(keep: (server: Server) => void): Promise<string> {
  const tokens: Record<string, { token: string; tool: string }> = {
    "/signin": { token: FIXTURE_TOKEN.signIn, tool: FIXTURE_TOOLS["zli-check-signin"] ?? "" },
    "/token": { token: FIXTURE_TOKEN.header, tool: FIXTURE_TOOLS["zli-check-token"] ?? "" },
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const route = tokens[request.url ?? ""];
    if (!route) return void response.writeHead(404).end();
    if (request.method === "DELETE") return void response.writeHead(200).end();
    if (request.method !== "POST") return void response.writeHead(405).end();
    if (request.headers.authorization !== `Bearer ${route.token}`) {
      return void response.writeHead(401, { "www-authenticate": 'Bearer realm="zli-check"' }).end();
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const message = record(JSON.parse(body));
      if (message.id === undefined) return void response.writeHead(202).end();
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "zli-check-session" });
      response.end(JSON.stringify(reply(message, route.tool)));
    });
  });
  keep(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function reply(message: Record<string, unknown>, tool: string): unknown {
  const id = message.id;
  if (message.method === "initialize") {
    const version = record(message.params).protocolVersion ?? "2025-06-18";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "zli-check", version: "1" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{ name: tool, description: "Replies pong.", inputSchema: { type: "object", properties: {} } }],
      },
    };
  }
  if (message.method === "tools/call")
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "pong" }] } };
  return { jsonrpc: "2.0", id, result: {} };
}

const LOCAL_SERVER = `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    const protocolVersion = message.params?.protocolVersion ?? "2025-06-18";
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "zli-check", version: "1" } } });
  }
  if (message.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "${FIXTURE_TOOLS["zli-check-local"]}", description: "Replies pong.", inputSchema: { type: "object", properties: {} } }] } });
  }
  if (message.method === "tools/call") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } });
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;
