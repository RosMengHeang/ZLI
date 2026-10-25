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
  /** A page where the person can create the value. */
  createUrl?: string;
};

export type McpCatalogCost = "free" | "account" | "paid";

export type McpCatalogCategory = "code" | "data" | "payments" | "monitoring" | "work" | "design" | "ai" | "local";

export const MCP_CATALOG_CATEGORIES: readonly { id: McpCatalogCategory; label: string }[] = [
  { id: "code", label: "Code and deploy" },
  { id: "data", label: "Databases and backend" },
  { id: "payments", label: "Payments" },
  { id: "monitoring", label: "Monitoring and analytics" },
  { id: "work", label: "Work and docs" },
  { id: "design", label: "Design" },
  { id: "ai", label: "Search and AI" },
  { id: "local", label: "Tools on this computer" },
];

type StdioTemplate = Omit<McpStdioServerConfig, "name" | "enabled" | "transport"> & { transport: "stdio" };
type HttpTemplate = Omit<McpHttpServerConfig, "name" | "enabled">;

export type McpCatalogEntry = {
  /** Also the server name it is added under. */
  id: string;
  title: string;
  description: string;
  homepage: string;
  category: McpCatalogCategory;
  cost: McpCatalogCost;
  costLabel: string;
  /** What must be on this computer for it to start, as a sentence. */
  needs?: string;
  fields: readonly McpCatalogField[];
  /** `{{key}}` marks where a field value goes. */
  template: StdioTemplate | HttpTemplate;
  /** A second way in for sign-in entries: paste a token instead. Its field key is `token`. */
  tokenOption?: { field: McpCatalogField; headers: Record<string, string> };
};

const NPX = "Needs Node.js (npx).";
const UVX = "Needs uv (uvx).";
const ACCOUNT = "Needs an account";
const FREE_PLAN = "Free plan, needs an account";

function npx(packageName: string, ...args: string[]): StdioTemplate {
  return { transport: "stdio", command: "npx", args: ["-y", packageName, ...args], env: {} };
}

function remote(url: string, options: { headers?: Record<string, string>; oauth?: boolean } = {}): HttpTemplate {
  return { transport: "http", url, headers: options.headers ?? {}, oauth: options.oauth ?? false };
}

/** A hosted server you sign in to with one click. ZLI handles the browser sign-in for every agent. */
function signIn(
  entry: Omit<McpCatalogEntry, "fields" | "template" | "cost" | "costLabel"> & {
    url: string;
    costLabel?: string;
    cost?: McpCatalogCost;
  },
): McpCatalogEntry {
  const { url, costLabel, cost, ...rest } = entry;
  return {
    ...rest,
    cost: cost ?? "account",
    costLabel: costLabel ?? FREE_PLAN,
    fields: [],
    template: remote(url, { oauth: true }),
  };
}

/**
 * Servers offered with one-click setup. Every sign-in address was checked for OAuth discovery and
 * dynamic client registration, which ZLI's sign-in needs.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  signIn({
    id: "github",
    title: "GitHub",
    description: "Repositories, issues, pull requests, and Actions.",
    homepage: "https://github.com/github/github-mcp-server",
    category: "code",
    costLabel: "Free, needs an account",
    url: "https://api.githubcopilot.com/mcp/",
    tokenOption: {
      field: {
        key: "token",
        label: "Personal access token",
        placeholder: "github_pat_...",
        hint: "Create one with repo and read:org access.",
        secret: true,
        createUrl: "https://github.com/settings/tokens/new?scopes=repo,read:org,read:user&description=ZLI",
      },
      headers: { Authorization: "Bearer {{token}}" },
    },
  }),
  signIn({
    id: "gitlab",
    title: "GitLab",
    description: "Issues, merge requests, pipelines, and code search on GitLab.com.",
    homepage: "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
    category: "code",
    costLabel: ACCOUNT,
    url: "https://gitlab.com/api/v4/mcp",
  }),
  signIn({
    id: "vercel",
    title: "Vercel",
    description: "Projects, deployments, build logs, and Vercel docs.",
    homepage: "https://vercel.com/docs/mcp/vercel-mcp",
    category: "code",
    url: "https://mcp.vercel.com",
  }),
  signIn({
    id: "netlify",
    title: "Netlify",
    description: "Create, deploy, and manage Netlify sites, forms, and environment variables.",
    homepage: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    category: "code",
    url: "https://netlify-mcp.netlify.app/mcp",
  }),
  signIn({
    id: "cloudflare",
    title: "Cloudflare",
    description: "Build on Workers with KV, R2, D1, and Hyperdrive in your Cloudflare account.",
    homepage: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    category: "code",
    url: "https://bindings.mcp.cloudflare.com/mcp",
  }),
  signIn({
    id: "railway",
    title: "Railway",
    description: "Deploy and manage Railway projects, services, variables, and logs.",
    homepage: "https://docs.railway.com/reference/mcp-server",
    category: "code",
    costLabel: ACCOUNT,
    url: "https://mcp.railway.com",
  }),
  {
    id: "render",
    title: "Render",
    description: "Services, databases, logs, and metrics on Render.",
    homepage: "https://render.com/docs/mcp-server",
    category: "code",
    cost: "account",
    costLabel: FREE_PLAN,
    fields: [
      {
        key: "apiKey",
        label: "API key",
        placeholder: "rnd_...",
        hint: "Create one in Render under Account settings, then API keys.",
        secret: true,
        createUrl: "https://dashboard.render.com/u/settings#api-keys",
      },
    ],
    template: remote("https://mcp.render.com/mcp", { headers: { Authorization: "Bearer {{apiKey}}" } }),
  },
  signIn({
    id: "supabase",
    title: "Supabase",
    description: "Run SQL, apply migrations, read logs, and generate types for your Supabase projects.",
    homepage: "https://supabase.com/docs/guides/ai-tools/mcp",
    category: "data",
    url: "https://mcp.supabase.com/mcp",
  }),
  signIn({
    id: "neon",
    title: "Neon",
    description: "Create Neon Postgres projects and branches, run SQL, and try migrations on a branch.",
    homepage: "https://neon.com/docs/ai/neon-mcp-server",
    category: "data",
    url: "https://mcp.neon.tech/mcp",
  }),
  signIn({
    id: "prisma",
    title: "Prisma Postgres",
    description: "Create and manage Prisma Postgres databases, backups, and connection strings.",
    homepage: "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    category: "data",
    url: "https://mcp.prisma.io/mcp",
  }),
  signIn({
    id: "planetscale",
    title: "PlanetScale",
    description: "Look at PlanetScale databases, branches, schema, and query insights.",
    homepage: "https://planetscale.com/docs/connect/mcp",
    category: "data",
    costLabel: ACCOUNT,
    url: "https://mcp.pscale.dev/mcp/planetscale",
  }),
  signIn({
    id: "clerk",
    title: "Clerk",
    description: "Users, organizations, and app settings in Clerk.",
    homepage: "https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server",
    category: "data",
    url: "https://mcp.clerk.com/mcp",
  }),
  signIn({
    id: "stripe",
    title: "Stripe",
    description: "Customers, payments, subscriptions, and refunds, plus Stripe docs search.",
    homepage: "https://docs.stripe.com/mcp",
    category: "payments",
    costLabel: ACCOUNT,
    url: "https://mcp.stripe.com",
  }),
  signIn({
    id: "paypal",
    title: "PayPal",
    description: "Invoices, orders, and transactions in your PayPal business account.",
    homepage: "https://developer.paypal.com/tools/mcp-server/",
    category: "payments",
    costLabel: ACCOUNT,
    url: "https://mcp.paypal.com/mcp",
  }),
  signIn({
    id: "square",
    title: "Square",
    description: "Payments, orders, catalog, and customers in Square.",
    homepage: "https://developer.squareup.com/docs/mcp",
    category: "payments",
    costLabel: ACCOUNT,
    url: "https://mcp.squareup.com/mcp",
  }),
  signIn({
    id: "sentry",
    title: "Sentry",
    description: "Errors, stack traces, and releases, and ask Seer for a root cause.",
    homepage: "https://mcp.sentry.dev",
    category: "monitoring",
    url: "https://mcp.sentry.dev/mcp",
  }),
  signIn({
    id: "posthog",
    title: "PostHog",
    description: "Product analytics, feature flags, experiments, and error tracking in PostHog.",
    homepage: "https://posthog.com/docs/model-context-protocol",
    category: "monitoring",
    url: "https://mcp.posthog.com/mcp",
  }),
  signIn({
    id: "grafana",
    title: "Grafana Cloud",
    description: "Search dashboards and query metrics and logs in Grafana Cloud.",
    homepage: "https://grafana.com/docs/grafana-cloud/",
    category: "monitoring",
    url: "https://mcp.grafana.com/mcp",
  }),
  signIn({
    id: "linear",
    title: "Linear",
    description: "Find, create, and update Linear issues, projects, and comments.",
    homepage: "https://linear.app/docs/mcp",
    category: "work",
    url: "https://mcp.linear.app/mcp",
  }),
  signIn({
    id: "notion",
    title: "Notion",
    description: "Search, read, and edit pages and databases in your Notion workspace.",
    homepage: "https://developers.notion.com/guides/mcp/overview",
    category: "work",
    url: "https://mcp.notion.com/mcp",
  }),
  signIn({
    id: "atlassian",
    title: "Atlassian",
    description: "Jira issues and Confluence pages in your Atlassian Cloud site.",
    homepage: "https://github.com/atlassian/atlassian-mcp-server",
    category: "work",
    url: "https://mcp.atlassian.com/v2/mcp",
  }),
  signIn({
    id: "clickup",
    title: "ClickUp",
    description: "Tasks, docs, and comments in ClickUp.",
    homepage: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    category: "work",
    url: "https://mcp.clickup.com/mcp",
  }),
  signIn({
    id: "monday",
    title: "monday.com",
    description: "Boards, items, and updates in monday.com.",
    homepage: "https://developer.monday.com/apps/docs/mondaycom-mcp-integration",
    category: "work",
    url: "https://mcp.monday.com/mcp",
  }),
  signIn({
    id: "todoist",
    title: "Todoist",
    description: "Add, find, and finish tasks and projects in Todoist.",
    homepage: "https://github.com/Doist/todoist-ai",
    category: "work",
    url: "https://ai.todoist.net/mcp",
  }),
  signIn({
    id: "airtable",
    title: "Airtable",
    description: "Read and update records, tables, and bases in Airtable.",
    homepage: "https://support.airtable.com/docs/using-the-airtable-mcp-server",
    category: "work",
    url: "https://mcp.airtable.com/mcp",
  }),
  signIn({
    id: "intercom",
    title: "Intercom",
    description: "Search Intercom conversations and contacts.",
    homepage: "https://developers.intercom.com/docs/guides/mcp",
    category: "work",
    costLabel: ACCOUNT,
    url: "https://mcp.intercom.com/mcp",
  }),
  signIn({
    id: "dropbox",
    title: "Dropbox",
    description: "Find, read, and organize files in Dropbox.",
    homepage: "https://www.dropbox.com/developers",
    category: "work",
    url: "https://mcp.dropbox.com/mcp",
  }),
  signIn({
    id: "zapier",
    title: "Zapier",
    description: "Run actions in the apps you connect in Zapier.",
    homepage: "https://zapier.com/mcp",
    category: "work",
    url: "https://mcp.zapier.com/api/mcp/mcp",
  }),
  signIn({
    id: "canva",
    title: "Canva",
    description: "Find, create, and edit Canva designs.",
    homepage: "https://www.canva.dev/docs/connect/canva-mcp-server-setup/",
    category: "design",
    url: "https://mcp.canva.com/mcp",
  }),
  signIn({
    id: "miro",
    title: "Miro",
    description: "Read Miro boards and add diagrams, notes, and docs to them.",
    homepage: "https://developers.miro.com/docs/miro-mcp",
    category: "design",
    url: "https://mcp.miro.com/",
  }),
  signIn({
    id: "webflow",
    title: "Webflow",
    description: "Sites, pages, and CMS content in Webflow.",
    homepage: "https://developers.webflow.com/data/docs/ai-tools",
    category: "design",
    url: "https://mcp.webflow.com/mcp",
  }),
  {
    id: "figma",
    title: "Figma",
    description: "Give agents the frames, components, and variables you select in the Figma desktop app.",
    homepage: "https://developers.figma.com/docs/figma-mcp-server/local-server-installation/",
    category: "design",
    cost: "paid",
    costLabel: "Needs a paid plan with a Dev or Full seat",
    needs: "Needs the Figma desktop app with its desktop MCP server turned on in Dev Mode.",
    fields: [],
    template: remote("http://127.0.0.1:3845/mcp"),
  },
  signIn({
    id: "huggingface",
    title: "Hugging Face",
    description:
      "Search models, datasets, Spaces, and papers on Hugging Face. Works without signing in, with fewer tools.",
    homepage: "https://huggingface.co/settings/mcp",
    category: "ai",
    url: "https://huggingface.co/mcp",
  }),
  {
    id: "context7",
    title: "Context7",
    description: "Up-to-date, version-specific library documentation and code examples.",
    homepage: "https://context7.com",
    category: "ai",
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
        createUrl: "https://context7.com/dashboard",
      },
    ],
    template: remote("https://mcp.context7.com/mcp", { headers: { Authorization: "Bearer {{apiKey}}" } }),
  },
  {
    id: "exa",
    title: "Exa",
    description: "Web search and code search built for agents.",
    homepage: "https://docs.exa.ai/reference/exa-mcp",
    category: "ai",
    cost: "free",
    costLabel: "Free, with rate limits",
    fields: [],
    template: remote("https://mcp.exa.ai/mcp"),
  },
  {
    id: "playwright",
    title: "Playwright",
    description: "Drive a real browser: open pages, click, type, and read the page through its accessibility tree.",
    homepage: "https://github.com/microsoft/playwright-mcp",
    category: "local",
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
    category: "local",
    cost: "free",
    costLabel: "Free",
    needs: "Needs Node.js (npx) and Chrome.",
    fields: [],
    template: npx("chrome-devtools-mcp@latest"),
  },
  {
    id: "filesystem",
    title: "Filesystem",
    description: "Read, write, and search files inside one folder you choose.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    category: "local",
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
    category: "local",
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
    category: "local",
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
    category: "local",
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
    category: "local",
    cost: "free",
    costLabel: "Free",
    needs: UVX,
    fields: [],
    template: { transport: "stdio", command: "uvx", args: ["mcp-server-git"], env: {} },
  },
];

/** Whether adding the entry gives a server ZLI signs in to. */
export function catalogSignsIn(entry: McpCatalogEntry): boolean {
  return entry.template.transport === "http" && entry.template.oauth;
}

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
 * are left out. On Windows, npx goes through cmd because agents start it without a shell. With
 * `useToken`, a sign-in entry's token option is used instead: a plain server with the token in a header.
 */
export function catalogServer(
  entry: McpCatalogEntry,
  values: Readonly<Record<string, string>>,
  options: { windows?: boolean; useToken?: boolean } = {},
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
    const token = options.useToken ? entry.tokenOption : undefined;
    return {
      name: entry.id,
      enabled: true,
      transport: "http",
      url: fill(template.url),
      headers: fillRecord(token ? token.headers : template.headers),
      oauth: token ? false : template.oauth,
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

/** The person's server that came from this catalog entry, under its own name or another. */
export function catalogEntryServer(
  entry: McpCatalogEntry,
  servers: readonly McpServerConfig[],
): McpServerConfig | undefined {
  const template = entry.template;
  return servers.find((server) => {
    if (server.name.toLowerCase() === entry.id) return true;
    if (template.transport === "http") return server.transport === "http" && sameUrl(server.url, template.url);
    if (server.transport === "http") return false;
    const packageArg = template.args.find((arg) => !arg.startsWith("-") && placeholders(arg).length === 0);
    return packageArg !== undefined && server.args.includes(packageArg);
  });
}

/** Whether the person already has this catalog server, under its own name or another. */
export function catalogEntryAdded(entry: McpCatalogEntry, servers: readonly McpServerConfig[]): boolean {
  return catalogEntryServer(entry, servers) !== undefined;
}
