import { z } from "zod";

import { AgentToolAccess, AgentToolScope } from "./agentControl.js";

/** Server names agents accept in every config format: Codex TOML keys, Claude tool prefixes, JSON keys. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
/** Names ZLI uses for its own servers. */
export const RESERVED_MCP_SERVER_NAMES: readonly string[] = ["zli", "zli-browser", "zli-mobile"];
export const MAX_MCP_SERVERS = 50;
/** HTTP header names (RFC 9110 tokens). */
export const MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/u;
export const MAX_MCP_DISABLED_TOOLS = 200;
export const MAX_MCP_SERVER_PROJECTS = 50;
export const MAX_MCP_TOOL_NAME = 200;
/** Most tools a connection test lists. */
export const MAX_MCP_TOOLS = 500;

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Environment names use letters, digits, and _.");
const HeaderName = z.string().regex(MCP_HEADER_NAME_PATTERN, "Header names use letters, digits, and - only.");
const HeaderValue = z
  .string()
  .max(8_000)
  .refine((value) => !/[\r\n\0]/u.test(value), "Header values must fit on one line.");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why a remote server address cannot be used, or undefined when it can. */
export function mcpServerUrlProblem(raw: string): string | undefined {
  if (/\s/u.test(raw)) return "The address cannot contain spaces.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter the full server address, starting with https://.";
  }
  if (url.username || url.password) return "Put credentials in a header, not in the address.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      ? undefined
      : "Use https://. Plain http:// works only for servers on this computer (localhost).";
  }
  return "The address must start with https://.";
}

const ServerName = z
  .string()
  .regex(MCP_SERVER_NAME_PATTERN, "Names use letters, digits, - and _, up to 64 characters.")
  .refine((name) => !RESERVED_MCP_SERVER_NAMES.includes(name.toLowerCase()), "This name is used by ZLI.");

/** Any server in the list, the person's or a plugin's. */
const AnyServerName = z
  .string()
  .regex(MCP_SERVER_NAME_PATTERN, "Names use letters, digits, - and _, up to 64 characters.");

/** Tools the person turned off. Agents never see them; ZLI's connect bridge hides them. */
const DisabledTools = z
  .array(z.string().min(1).max(MAX_MCP_TOOL_NAME))
  .max(MAX_MCP_DISABLED_TOOLS, `Turn off up to ${MAX_MCP_DISABLED_TOOLS} tools.`);

/** Full project root paths. Missing or empty means every project. */
const ProjectPaths = z
  .array(
    z
      .string()
      .min(1)
      .max(4_000)
      .refine((path) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path), "Use the full path of the project folder."),
  )
  .max(MAX_MCP_SERVER_PROJECTS, `Pick up to ${MAX_MCP_SERVER_PROJECTS} projects.`);

/** A local server that the agent starts as a process and talks to over stdio. Older files have no transport. */
export const McpStdioServerConfig = z.object({
  name: ServerName,
  enabled: z.boolean(),
  transport: z.literal("stdio").optional(),
  command: z.string().trim().min(1, "Add the command that starts the server.").max(2_000),
  args: z.array(z.string().max(4_000)).max(64),
  env: z.record(EnvName, z.string().max(8_000)),
  disabledTools: DisabledTools.optional(),
  projects: ProjectPaths.optional(),
});
export type McpStdioServerConfig = z.infer<typeof McpStdioServerConfig>;

/** A remote server reached over streamable HTTP. */
export const McpHttpServerConfig = z.object({
  name: ServerName,
  enabled: z.boolean(),
  transport: z.literal("http"),
  url: z
    .string()
    .trim()
    .min(1, "Add the server address.")
    .max(2_000)
    .superRefine((url, context) => {
      const problem = mcpServerUrlProblem(url);
      if (problem) context.addIssue({ code: "custom", message: problem });
    }),
  headers: z
    .record(HeaderName, HeaderValue)
    .refine((headers) => Object.keys(headers).length <= 32, "Use up to 32 headers."),
  /**
   * Signs in through ZLI (OAuth). ZLI keeps the login and agents reach the server through ZLI's connect
   * bridge, which adds a fresh token, so one sign-in works in every agent.
   */
  oauth: z.boolean(),
  disabledTools: DisabledTools.optional(),
  projects: ProjectPaths.optional(),
});
export type McpHttpServerConfig = z.infer<typeof McpHttpServerConfig>;

/** An MCP server that ZLI hands to every agent it starts. */
export const McpServerConfig = z.discriminatedUnion("transport", [McpStdioServerConfig, McpHttpServerConfig]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** Whether agents in every project get the server, or only agents in the projects it lists. */
export function mcpServerForAllProjects(server: Pick<McpServerConfig, "projects">): boolean {
  return (server.projects?.length ?? 0) === 0;
}

export function isHttpServer(server: McpServerConfig): server is McpHttpServerConfig {
  return server.transport === "http";
}

export const McpServerList = z
  .array(McpServerConfig)
  .max(MAX_MCP_SERVERS)
  .superRefine((servers, context) => {
    const seen = new Set<string>();
    servers.forEach((server, index) => {
      const key = server.name.toLowerCase();
      if (seen.has(key)) {
        context.addIssue({ code: "custom", message: `${server.name} is listed twice.`, path: [index, "name"] });
      }
      seen.add(key);
    });
  });

/** Handled directly by the runtime server; none of these reach the event log. */
export const McpCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mcp.list") }),
  z.object({ type: z.literal("mcp.save"), servers: McpServerList }),
  z.object({ type: z.literal("mcp.agentAccess"), access: AgentToolAccess }),
  z.object({ type: z.literal("mcp.agentScope"), scope: AgentToolScope }),
  /** Starts signing in to a sign-in server; replies with McpSignInStart. */
  z.object({ type: z.literal("mcp.signIn"), name: ServerName }),
  /** Replies with McpListResult once the browser sign-in is saved. */
  z.object({ type: z.literal("mcp.signIn.wait"), attemptId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("mcp.signIn.cancel"), attemptId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("mcp.signOut"), name: ServerName }),
  /** Starts the server, lists its tools, and replies with McpTestResult. */
  z.object({ type: z.literal("mcp.test"), name: AnyServerName }),
  /** Looks for MCP servers set up in other apps on this computer; replies with McpImportResult. */
  z.object({ type: z.literal("mcp.import.scan") }),
]);
export type McpCommand = z.infer<typeof McpCommand>;
export const MCP_COMMAND_TYPES = [
  "mcp.list",
  "mcp.save",
  "mcp.agentAccess",
  "mcp.agentScope",
  "mcp.signIn",
  "mcp.signIn.wait",
  "mcp.signIn.cancel",
  "mcp.signOut",
  "mcp.test",
  "mcp.import.scan",
] as const;

/** How a sign-in server is signed in, for every server with `oauth` on, the person's and plugins'. */
export const McpSignInState = z.object({
  name: z.string(),
  url: z.string(),
  signedIn: z.boolean(),
  /** browser: OAuth in the browser. github-cli: the GitHub CLI's login. github-code: GitHub device code. */
  via: z.enum(["browser", "github-cli", "github-code"]).optional(),
  account: z.string().optional(),
  signedInAt: z.string().optional(),
  /** The server turned the saved login down, so the person has to sign in again. */
  expired: z.boolean().optional(),
});
export type McpSignInState = z.infer<typeof McpSignInState>;

export const McpToolInfo = z.object({
  name: z.string().min(1).max(MAX_MCP_TOOL_NAME),
  description: z.string().max(1_000).optional(),
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

/** Reply to mcp.test. */
export const McpTestResult = z.object({
  name: z.string(),
  ok: z.boolean(),
  /** Every tool the server offers, including ones turned off in ZLI. */
  tools: z.array(McpToolInfo).max(MAX_MCP_TOOLS),
  problem: z.string().optional(),
  needsSignIn: z.boolean().optional(),
  testedAt: z.string().datetime({ offset: true }),
});
export type McpTestResult = z.infer<typeof McpTestResult>;

/** The last test of one server since ZLI started. */
export const McpServerHealth = z.object({
  name: z.string(),
  ok: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  problem: z.string().optional(),
  needsSignIn: z.boolean().optional(),
  testedAt: z.string().datetime({ offset: true }),
});
export type McpServerHealth = z.infer<typeof McpServerHealth>;

export const McpListResult = z.object({
  servers: z.array(McpServerConfig),
  /** What the built-in `zli` server lets agents do with other agents. */
  agentAccess: AgentToolAccess,
  /** Which projects' agents the `zli` server can see. Older runtimes leave it out, which means the caller's project. */
  agentScope: AgentToolScope.default("project"),
  signIns: z.array(McpSignInState).default([]),
  /** Results of mcp.test since ZLI started. */
  health: z.array(McpServerHealth).default([]),
  /** Set when the saved list could not be read; saving replaces it. */
  problem: z.string().optional(),
});
export type McpListResult = z.infer<typeof McpListResult>;

/** Reply to mcp.signIn: either done already, or a page to open (with a code to enter for GitHub). */
export const McpSignInStart = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), list: McpListResult }),
  z.object({
    status: z.literal("open"),
    attemptId: z.string(),
    url: z.string(),
    code: z.string().optional(),
  }),
]);
export type McpSignInStart = z.infer<typeof McpSignInStart>;

export const MCP_IMPORT_APPS = ["claude-desktop", "claude-code", "cursor", "vscode", "windsurf"] as const;
export const McpImportApp = z.enum(MCP_IMPORT_APPS);
export type McpImportApp = z.infer<typeof McpImportApp>;

/** A server set up in another app that ZLI can copy. Saving it goes through mcp.save. */
export const McpImportCandidate = z.object({
  app: McpImportApp,
  appLabel: z.string(),
  /** The settings file it came from. */
  path: z.string(),
  server: McpServerConfig,
  /** ZLI already has a server with this name. */
  exists: z.boolean(),
  note: z.string().optional(),
});
export type McpImportCandidate = z.infer<typeof McpImportCandidate>;

/** Reply to mcp.import.scan. */
export const McpImportResult = z.object({
  found: z.array(McpImportCandidate),
  /** Servers or files ZLI skipped, in plain words. */
  problems: z.array(z.string()),
});
export type McpImportResult = z.infer<typeof McpImportResult>;
