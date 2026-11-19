/**
 * The apps the Connected apps window offers, by Composio's id, in the groups it shows them in. Any other app
 * Composio knows can still be named by its id. Ids checked against Composio's logo service.
 */
export const CONNECTED_APP_GROUPS = [
  "Email and calendar",
  "Chat",
  "Projects and docs",
  "Code",
  "Design",
  "Sales and support",
  "Files",
  "Social",
] as const;
export type ConnectedAppGroup = (typeof CONNECTED_APP_GROUPS)[number];

export type ConnectedAppEntry = { app: string; title: string; group: ConnectedAppGroup; blurb: string };

export const CONNECTED_APP_CATALOG: readonly ConnectedAppEntry[] = [
  { app: "gmail", title: "Gmail", group: "Email and calendar", blurb: "Read, sort and send email" },
  { app: "googlecalendar", title: "Google Calendar", group: "Email and calendar", blurb: "Events and free time" },
  { app: "outlook", title: "Outlook", group: "Email and calendar", blurb: "Microsoft mail and calendar" },
  { app: "calendly", title: "Calendly", group: "Email and calendar", blurb: "Bookings and links" },
  { app: "zoom", title: "Zoom", group: "Email and calendar", blurb: "Meetings and recordings" },
  { app: "slack", title: "Slack", group: "Chat", blurb: "Channels and messages" },
  { app: "discord", title: "Discord", group: "Chat", blurb: "Servers and channels" },
  { app: "microsoft_teams", title: "Microsoft Teams", group: "Chat", blurb: "Chats and channels" },
  { app: "telegram", title: "Telegram", group: "Chat", blurb: "Bot messages" },
  { app: "whatsapp", title: "WhatsApp", group: "Chat", blurb: "Business messages" },
  { app: "notion", title: "Notion", group: "Projects and docs", blurb: "Pages and databases" },
  { app: "linear", title: "Linear", group: "Projects and docs", blurb: "Issues and projects" },
  { app: "jira", title: "Jira", group: "Projects and docs", blurb: "Issues and sprints" },
  { app: "confluence", title: "Confluence", group: "Projects and docs", blurb: "Team pages" },
  { app: "asana", title: "Asana", group: "Projects and docs", blurb: "Tasks and projects" },
  { app: "trello", title: "Trello", group: "Projects and docs", blurb: "Boards and cards" },
  { app: "clickup", title: "ClickUp", group: "Projects and docs", blurb: "Tasks and docs" },
  { app: "todoist", title: "Todoist", group: "Projects and docs", blurb: "To-dos" },
  { app: "monday", title: "monday.com", group: "Projects and docs", blurb: "Boards and items" },
  { app: "airtable", title: "Airtable", group: "Projects and docs", blurb: "Bases and records" },
  { app: "googledocs", title: "Google Docs", group: "Projects and docs", blurb: "Documents" },
  { app: "googlesheets", title: "Google Sheets", group: "Projects and docs", blurb: "Spreadsheets" },
  { app: "github", title: "GitHub", group: "Code", blurb: "Repos, issues and pull requests" },
  { app: "gitlab", title: "GitLab", group: "Code", blurb: "Projects and merge requests" },
  { app: "bitbucket", title: "Bitbucket", group: "Code", blurb: "Repos and pull requests" },
  { app: "vercel", title: "Vercel", group: "Code", blurb: "Deployments and domains" },
  { app: "supabase", title: "Supabase", group: "Code", blurb: "Databases and auth" },
  { app: "cloudflare", title: "Cloudflare", group: "Code", blurb: "DNS, Workers and pages" },
  { app: "sentry", title: "Sentry", group: "Code", blurb: "Errors and issues" },
  { app: "datadog", title: "Datadog", group: "Code", blurb: "Metrics and monitors" },
  { app: "posthog", title: "PostHog", group: "Code", blurb: "Product analytics" },
  { app: "figma", title: "Figma", group: "Design", blurb: "Files and comments" },
  { app: "canva", title: "Canva", group: "Design", blurb: "Designs" },
  { app: "miro", title: "Miro", group: "Design", blurb: "Boards" },
  { app: "webflow", title: "Webflow", group: "Design", blurb: "Sites and CMS" },
  { app: "hubspot", title: "HubSpot", group: "Sales and support", blurb: "Contacts and deals" },
  { app: "salesforce", title: "Salesforce", group: "Sales and support", blurb: "Accounts and opportunities" },
  { app: "stripe", title: "Stripe", group: "Sales and support", blurb: "Payments and customers" },
  { app: "shopify", title: "Shopify", group: "Sales and support", blurb: "Orders and products" },
  { app: "zendesk", title: "Zendesk", group: "Sales and support", blurb: "Support tickets" },
  { app: "intercom", title: "Intercom", group: "Sales and support", blurb: "Conversations" },
  { app: "mailchimp", title: "Mailchimp", group: "Sales and support", blurb: "Audiences and campaigns" },
  { app: "googledrive", title: "Google Drive", group: "Files", blurb: "Files and folders" },
  { app: "dropbox", title: "Dropbox", group: "Files", blurb: "Files and folders" },
  { app: "one_drive", title: "OneDrive", group: "Files", blurb: "Microsoft files" },
  { app: "1password", title: "1Password", group: "Files", blurb: "Vaults and items" },
  { app: "linkedin", title: "LinkedIn", group: "Social", blurb: "Posts and profile" },
  { app: "twitter", title: "X (Twitter)", group: "Social", blurb: "Posts" },
  { app: "reddit", title: "Reddit", group: "Social", blurb: "Posts and comments" },
  { app: "youtube", title: "YouTube", group: "Social", blurb: "Videos and channels" },
];

/** The first few the window recommends. */
export const RECOMMENDED_APPS: readonly string[] = ["gmail", "googlecalendar", "slack", "github", "notion", "linear"];

/** A Composio app id: lowercase letters, digits, _ and -. */
export const CONNECTED_APP_ID = /^[a-z0-9_-]{2,60}$/u;

/**
 * A card for something an agent wants to do in the person's apps (send an email, post a message). It stays in
 * the chat until the person sends or discards it, even after the agent's turn ends; ZLI then runs it itself.
 */
export const APP_DRAFT_PREFIX = "apps-";

export function isAppDraft(requestId: string): boolean {
  return requestId.startsWith(APP_DRAFT_PREFIX);
}

/** The parts of an email the person can change on its card before it goes out. */
export type AppDraftEmail = { to: string; cc: string; subject: string; body: string };
