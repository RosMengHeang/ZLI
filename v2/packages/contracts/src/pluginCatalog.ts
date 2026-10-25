/** Groups for the built-in plugin list. */
export type PluginCatalogCategory = "code" | "review" | "design" | "data" | "deploy" | "work";

export const PLUGIN_CATALOG_CATEGORIES: readonly { id: PluginCatalogCategory; label: string }[] = [
  { id: "code", label: "Coding" },
  { id: "review", label: "Review and git" },
  { id: "design", label: "Design" },
  { id: "data", label: "Backend and data" },
  { id: "deploy", label: "Deploy and monitor" },
  { id: "work", label: "Work and chat" },
];

export type PluginCatalogEntry = {
  /** The plugin name it installs under. */
  id: string;
  title: string;
  description: string;
  publisher: string;
  category: PluginCatalogCategory;
  /** What to pass to plugins.previewInstall. */
  source: string;
  homepage: string;
  /** A key in the web app's connector logos. */
  logoId?: string;
};

const OFFICIAL = "https://github.com/anthropics/claude-plugins-official/tree/main";

/**
 * Plugins checked to bring skills, prompts, or MCP servers ZLI can use. Plugins that only add hooks,
 * subagents, or language servers are left out, since ZLI ignores those parts.
 */
export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
  {
    id: "code-review",
    title: "Code review",
    description: "Reviews a pull request and reports only the issues it is confident about.",
    publisher: "Anthropic",
    category: "review",
    source: `${OFFICIAL}/plugins/code-review`,
    homepage: `${OFFICIAL}/plugins/code-review`,
  },
  {
    id: "commit-commands",
    title: "Commit commands",
    description: "Prompts to commit, push, open a pull request, and clean up merged branches.",
    publisher: "Anthropic",
    category: "review",
    source: `${OFFICIAL}/plugins/commit-commands`,
    homepage: `${OFFICIAL}/plugins/commit-commands`,
    logoId: "git",
  },
  {
    id: "gitlab",
    title: "GitLab",
    description: "Lets agents work with GitLab merge requests, issues, and pipelines.",
    publisher: "GitLab",
    category: "review",
    source: `${OFFICIAL}/external_plugins/gitlab`,
    homepage: "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
    logoId: "gitlab",
  },
  {
    id: "frontend-design",
    title: "Frontend design",
    description: "Teaches agents to build polished, distinctive web interfaces instead of generic ones.",
    publisher: "Anthropic",
    category: "design",
    source: `${OFFICIAL}/plugins/frontend-design`,
    homepage: `${OFFICIAL}/plugins/frontend-design`,
  },
  {
    id: "figma",
    title: "Figma",
    description: "Skills and the Figma MCP server for turning designs into code.",
    publisher: "Figma",
    category: "design",
    source: "https://github.com/figma/mcp-server-guide/tree/main",
    homepage: "https://github.com/figma/mcp-server-guide",
    logoId: "figma",
  },
  {
    id: "skill-creator",
    title: "Skill creator",
    description: "Helps agents write new skills, improve existing ones, and test how well they work.",
    publisher: "Anthropic",
    category: "code",
    source: `${OFFICIAL}/plugins/skill-creator`,
    homepage: `${OFFICIAL}/plugins/skill-creator`,
  },
  {
    id: "plugin-dev",
    title: "Plugin development",
    description: "Skills and a guided prompt for building Claude Code plugins.",
    publisher: "Anthropic",
    category: "code",
    source: `${OFFICIAL}/plugins/plugin-dev`,
    homepage: `${OFFICIAL}/plugins/plugin-dev`,
  },
  {
    id: "claude-md-management",
    title: "CLAUDE.md management",
    description: "Checks and improves CLAUDE.md files and saves what a session learned.",
    publisher: "Anthropic",
    category: "code",
    source: `${OFFICIAL}/plugins/claude-md-management`,
    homepage: `${OFFICIAL}/plugins/claude-md-management`,
  },
  {
    id: "context7",
    title: "Context7",
    description: "Gives agents current documentation and code examples for the libraries you use.",
    publisher: "Upstash",
    category: "code",
    source: `${OFFICIAL}/external_plugins/context7`,
    homepage: "https://context7.com",
  },
  {
    id: "playwright",
    title: "Playwright",
    description: "Lets agents open web pages in a browser, click through them, and take screenshots.",
    publisher: "Microsoft",
    category: "code",
    source: `${OFFICIAL}/external_plugins/playwright`,
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "supabase",
    title: "Supabase",
    description: "Skills and the Supabase MCP server for databases, auth, and storage.",
    publisher: "Supabase",
    category: "data",
    source: "https://github.com/supabase-community/supabase-plugin/tree/main",
    homepage: "https://github.com/supabase-community/supabase-plugin",
    logoId: "supabase",
  },
  {
    id: "neon",
    title: "Neon",
    description: "Skills and the Neon MCP server for Postgres projects and branches.",
    publisher: "Neon",
    category: "data",
    source: "https://github.com/neondatabase/agent-skills/tree/main/plugins/neon-postgres",
    homepage: "https://github.com/neondatabase/agent-skills/tree/main/plugins/neon-postgres",
    logoId: "neon",
  },
  {
    id: "firebase",
    title: "Firebase",
    description: "Lets agents manage Firestore, auth, functions, and hosting through the Firebase MCP server.",
    publisher: "Google",
    category: "data",
    source: `${OFFICIAL}/external_plugins/firebase`,
    homepage: "https://firebase.google.com/docs/ai-assistance/mcp-server",
  },
  {
    id: "stripe",
    title: "Stripe",
    description: "Skills, prompts, and the Stripe MCP server for building payments.",
    publisher: "Stripe",
    category: "data",
    source: "https://github.com/stripe/ai/tree/main/providers/claude/plugin",
    homepage: "https://github.com/stripe/ai/tree/main/providers/claude/plugin",
    logoId: "stripe",
  },
  {
    id: "vercel",
    title: "Vercel",
    description: "Skills, prompts, and the Vercel MCP server for deploying and checking projects.",
    publisher: "Vercel",
    category: "deploy",
    source: "https://github.com/vercel/vercel-plugin/tree/main",
    homepage: "https://github.com/vercel/vercel-plugin",
    logoId: "vercel",
  },
  {
    id: "cloudflare",
    title: "Cloudflare",
    description: "Skills and the Cloudflare MCP server for Workers and the rest of the platform.",
    publisher: "Cloudflare",
    category: "deploy",
    source: "https://github.com/cloudflare/skills/tree/main",
    homepage: "https://github.com/cloudflare/skills",
    logoId: "cloudflare",
  },
  {
    id: "sentry",
    title: "Sentry",
    description: "Skills and the Sentry MCP server for finding and fixing production errors.",
    publisher: "Sentry",
    category: "deploy",
    source: "https://github.com/getsentry/plugin-claude/tree/main",
    homepage: "https://github.com/getsentry/plugin-claude",
    logoId: "sentry",
  },
  {
    id: "linear",
    title: "Linear",
    description: "Lets agents find, create, and update Linear issues and projects.",
    publisher: "Linear",
    category: "work",
    source: `${OFFICIAL}/external_plugins/linear`,
    homepage: "https://linear.app/docs/mcp",
    logoId: "linear",
  },
  {
    id: "slack",
    title: "Slack",
    description: "Skills, prompts, and the Slack MCP server for searching and summarizing channels.",
    publisher: "Slack",
    category: "work",
    source: "https://github.com/slackapi/slack-mcp-plugin/tree/main",
    homepage: "https://github.com/slackapi/slack-mcp-plugin",
  },
];
