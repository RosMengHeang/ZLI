import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from "./mcp.js";

/** A value the person fills in before a catalog server is added, such as an access token. */
export type McpCatalogField = {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Hidden while typed and never shown again in the list. */
  secret?: boolean;
  /** When left empty, the header, argument, or variable that uses it is left out. */
  optional?: boolean;
};

export type McpCatalogCost = "free" | "account" | "paid";

type StdioTemplate = Omit<McpStdioServerConfig, "name" | "enabled" | "transport"> & { transport: "stdio" };
type HttpTemplate = Omit<McpHttpServerConfig, "name" | "enabled">;

export type McpCatalogEntry = {
  /** Also the server name it is added under. */
  id: string;
  title: string;
  description: string;
  homepage: string;
  cost: McpCatalogCost;
  costLabel: string;
  /** What must be on this computer for it to start, as a sentence. */
  needs?: string;
  fields: readonly McpCatalogField[];
  /** `{{key}}` marks where a field value goes. */
  template: StdioTemplate | HttpTemplate;
};

const NPX = "Needs Node.js (npx).";
const UVX = "Needs uv (uvx).";
const OAUTH = "Opens your browser to sign in the first time an agent uses it. Needs Node.js (npx).";

function npx(packageName: string, ...args: string[]): StdioTemplate {
  return { transport: "stdio", command: "npx", args: ["-y", packageName, ...args], env: {} };
}

function remote(url: string, options: { headers?: Record<string, string>; oauth?: boolean } = {}): HttpTemplate {
  return { transport: "http", url, headers: options.headers ?? {}, oauth: options.oauth ?? false };
}

/** Popular servers offered with one-click setup. Package names and addresses were checked against each project's docs. */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "github",
    title: "GitHub",
    description: "Read and manage repositories, issues, pull requests, and Actions through GitHub's hosted server.",
    homepage: "https://github.com/github/github-mcp-server",
    cost: "account",
    costLabel: "Free, needs a GitHub account",
    fields: [
      {
        key: "token",
        label: "Personal access token",
        placeholder: "github_pat_...",
        hint: "Create one at github.com/settings/personal-access-tokens.",
        secret: true,
      },
    ],
    template: remote("https://api.githubcopilot.com/mcp/", { headers: { Authorization: "Bearer {{token}}" } }),
  },
  {
    id: "playwright",
    title: "Playwright",
    description: "Drive a real browser: open pages, click, type, and read the page through its accessibility tree.",
    homepage: "https://github.com/microsoft/playwright-mcp",
    cost: "free",
    costLabel: "Free",
    needs: NPX,
    fields: [],
    template: npx("@playwright/mcp@latest"),
  },
  {
    id: "chrome-devtools",
    title: "Chrome DevTools",
    description: "Inspect and debug a live Chrome: console, network requests, performance traces, and screenshots.",
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    cost: "free",
    costLabel: "Free",
    needs: "Needs Node.js (npx) and Chrome.",
    fields: [],
    template: npx("chrome-devtools-mcp@latest"),
  },
  {
    id: "context7",
    title: "Context7",
    description: "Up-to-date, version-specific library documentation and code examples.",
    homepage: "https://context7.com",
    cost: "free",
    costLabel: "Free, an API key raises the limits",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        placeholder: "ctx7sk-...",
        hint: "Optional. Get one free at context7.com/dashboard.",
        secret: true,
        optional: true,
      },
    ],
    template: remote("https://mcp.context7.com/mcp", { headers: { Authorization: "Bearer {{apiKey}}" } }),
  },
  {
    id: "filesystem",
    title: "Filesystem",
    description: "Read, write, and search files inside one folder you choose.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    cost: "free",
    costLabel: "Free",
    needs: NPX,
    fields: [{ key: "folder", label: "Folder", placeholder: "/Users/me/notes", hint: "The only folder it can reach." }],
    template: npx("@modelcontextprotocol/server-filesystem", "{{folder}}"),
  },
  {
    id: "fetch",
    title: "Fetch",
    description: "Fetch web pages and turn them into Markdown the agent can read.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    cost: "free",
    costLabel: "Free",
    needs: UVX,
    fields: [],
    template: { transport: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: {} },
  },
  {
    id: "memory",
    title: "Memory",
    description: "A local knowledge graph agents can store facts in and recall across sessions.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    cost: "free",
    costLabel: "Free",
    needs: NPX,
    fields: [],
    template: npx("@modelcontextprotocol/server-memory"),
  },
  {
    id: "sequential-thinking",
    title: "Sequential thinking",
    description: "A scratchpad tool for working through a problem step by step and revising earlier steps.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    cost: "free",
    costLabel: "Free",
    needs: NPX,
    fields: [],
    template: npx("@modelcontextprotocol/server-sequential-thinking"),
  },
  {
    id: "git",
    title: "Git",
    description: "Read history, diffs, and branches, and make commits in local Git repositories.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    cost: "free",
    costLabel: "Free",
    needs: UVX,
    fields: [],
    template: { transport: "stdio", command: "uvx", args: ["mcp-server-git"], env: {} },
  },
  {
    id: "sentry",
    title: "Sentry",
    description: "Look up errors, stack traces, and releases, and ask Seer for a root cause.",
    homepage: "https://mcp.sentry.dev",
    cost: "account",
    costLabel: "Free plan, needs an account",
    needs: OAUTH,
    fields: [],
    template: remote("https://mcp.sentry.dev/mcp", { oauth: true }),
  },
  {
    id: "linear",
    title: "Linear",
    description: "Find, create, and update Linear issues, projects, and comments.",
    homepage: "https://linear.app/docs/mcp",
    cost: "account",
    costLabel: "Free plan, needs an account",
    needs: OAUTH,
    fields: [],
    template: remote("https://mcp.linear.app/mcp", { oauth: true }),
  },
  {
    id: "notion",
    title: "Notion",
    description: "Search, read, and edit pages and databases in your Notion workspace.",
    homepage: "https://developers.notion.com/guides/mcp/overview",
    cost: "account",
    costLabel: "Free plan, needs an account",
    needs: OAUTH,
    fields: [],
    template: remote("https://mcp.notion.com/mcp", { oauth: true }),
  },
  {
    id: "atlassian",
    title: "Atlassian",
    description: "Work with Jira issues and Confluence pages in your Atlassian Cloud site.",
    homepage: "https://github.com/atlassian/atlassian-mcp-server",
    cost: "account",
    costLabel: "Free plan, needs an account",
    needs: OAUTH,
    fields: [],
    template: remote("https://mcp.atlassian.com/v2/mcp", { oauth: true }),
  },
  {
    id: "supabase",
    title: "Supabase",
    description: "Manage Supabase projects: run SQL, apply migrations, read logs, and generate types.",
    homepage: "https://supabase.com/docs/guides/ai-tools/mcp",
    cost: "account",
    costLabel: "Free plan, needs an account",
    needs: OAUTH,
    fields: [],
    template: remote("https://mcp.supabase.com/mcp", { oauth: true }),
  },
  {
    id: "figma",
    title: "Figma",
    description: "Give agents the frames, components, and variables you select in the Figma desktop app.",
    homepage: "https://developers.figma.com/docs/figma-mcp-server/local-server-installation/",
    cost: "paid",
    costLabel: "Needs a paid plan with a Dev or Full seat",
    needs: "Needs the Figma desktop app with its desktop MCP server turned on in Dev Mode.",
    fields: [],
    template: remote("http://127.0.0.1:3845/mcp"),
  },
];

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/gu;

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

/** The first required field left empty, or undefined when the entry can be added. */
export function catalogMissingField(
  entry: McpCatalogEntry,
  values: Readonly<Record<string, string>>,
): McpCatalogField | undefined {
  return entry.fields.find((field) => !field.optional && !values[field.key]?.trim());
}

/**
 * The server a catalog entry adds once its fields are filled in. Pieces that use an empty optional field
 * are left out. On Windows, npx goes through cmd because agents start it without a shell.
 */
export function catalogServer(
  entry: McpCatalogEntry,
  values: Readonly<Record<string, string>>,
  options: { windows?: boolean } = {},
): McpServerConfig {
  const value = (key: string) => values[key]?.trim() ?? "";
  const usable = (text: string) => placeholders(text).every((key) => value(key).length > 0);
  const fill = (text: string) => text.replace(PLACEHOLDER, (_, key: string) => value(key));
  const fillRecord = (record: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(record)
        .filter(([, text]) => usable(text))
        .map(([key, text]) => [key, fill(text)]),
    );
  const template = entry.template;
  if (template.transport === "http") {
    return {
      name: entry.id,
      enabled: true,
      transport: "http",
      url: fill(template.url),
      headers: fillRecord(template.headers),
      oauth: template.oauth,
    };
  }
  const args = template.args.filter(usable).map(fill);
  const wrap = options.windows === true && template.command === "npx";
  return {
    name: entry.id,
    enabled: true,
    command: wrap ? "cmd" : template.command,
    args: wrap ? ["/c", "npx", ...args] : args,
    env: fillRecord(template.env),
  };
}

function sameUrl(left: string, right: string): boolean {
  const normal = (url: string) => url.trim().replace(/\/+$/u, "").toLowerCase();
  return normal(left) === normal(right);
}

/** Whether the person already has this catalog server, under its own name or another. */
export function catalogEntryAdded(entry: McpCatalogEntry, servers: readonly McpServerConfig[]): boolean {
  const template = entry.template;
  return servers.some((server) => {
    if (server.name.toLowerCase() === entry.id) return true;
    if (template.transport === "http") return server.transport === "http" && sameUrl(server.url, template.url);
    if (server.transport === "http") return false;
    const packageArg = template.args.find((arg) => !arg.startsWith("-") && placeholders(arg).length === 0);
    return packageArg !== undefined && server.args.includes(packageArg);
  });
}
