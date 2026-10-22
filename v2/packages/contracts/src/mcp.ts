import { z } from "zod";

/** Server names agents accept in every config format: Codex TOML keys, Claude tool prefixes, JSON keys. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
/** Names ZLI uses for its own servers. */
export const RESERVED_MCP_SERVER_NAMES: readonly string[] = ["zli", "zli-browser"];
export const MAX_MCP_SERVERS = 50;

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Environment names use letters, digits, and _.");

/** A local stdio MCP server that ZLI hands to every agent it starts. */
export const McpServerConfig = z.object({
  name: z
    .string()
    .regex(MCP_SERVER_NAME_PATTERN, "Names use letters, digits, - and _, up to 64 characters.")
    .refine((name) => !RESERVED_MCP_SERVER_NAMES.includes(name.toLowerCase()), "This name is used by ZLI."),
  enabled: z.boolean(),
  command: z.string().trim().min(1, "Add the command that starts the server.").max(2_000),
  args: z.array(z.string().max(4_000)).max(64),
  env: z.record(EnvName, z.string().max(8_000)),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

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
]);
export type McpCommand = z.infer<typeof McpCommand>;
export const MCP_COMMAND_TYPES = ["mcp.list", "mcp.save"] as const;

/** What happened to one agent's user settings file when ZLI copied the servers into it. */
export const McpSettingsOutcome = z.object({
  provider: z.string(),
  path: z.string(),
  status: z.enum(["created", "updated", "unchanged", "skipped-absent", "skipped-invalid", "failed"]),
  message: z.string().optional(),
});
export type McpSettingsOutcome = z.infer<typeof McpSettingsOutcome>;

export const McpListResult = z.object({
  servers: z.array(McpServerConfig),
  /** Cursor, Droid, Gemini, Kimi, and Qwen read MCP servers only from their own settings files. */
  userSettings: z.object({
    enabled: z.boolean(),
    outcomes: z.array(McpSettingsOutcome),
  }),
  /** Set when the saved list could not be read; saving replaces it. */
  problem: z.string().optional(),
});
export type McpListResult = z.infer<typeof McpListResult>;
