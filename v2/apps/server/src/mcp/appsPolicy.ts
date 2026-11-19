import type { AppDraftEmail } from "@zli-v2/contracts";

/**
 * Which calls to the connected apps a buddy may make on its own. Reading (search, list, fetch, get) goes ahead;
 * anything that sends, changes, deletes or runs code in a person's accounts waits for the person's OK, whatever
 * the buddy's permission. A page or an email can carry instructions, and this is what stops a buddy that was
 * talked into it from mailing someone's data away.
 */

/** Composio's own tools that only look things up. */
const LOOKUPS = new Set([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_SEARCH_SKILLS",
  "COMPOSIO_USE_SKILL",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
]);

/** Words in an app action's name that change something. Any one of them makes the action need an OK. */
const WRITE_WORDS = new Set(
  (
    "SEND REPLY FORWARD POST PUBLISH CREATE ADD INSERT NEW UPDATE EDIT MODIFY PATCH PUT SET REPLACE RENAME WRITE " +
    "APPEND UPLOAD IMPORT DELETE REMOVE TRASH ARCHIVE CLEAR PURGE MOVE COPY MERGE CLOSE REOPEN MARK STAR LABEL " +
    "TAG ASSIGN UNASSIGN COMMENT REACT DRAFT SCHEDULE CANCEL APPROVE REJECT ACCEPT DECLINE INVITE SHARE " +
    "UNSHARE JOIN LEAVE KICK BAN BLOCK UNBLOCK SUBSCRIBE UNSUBSCRIBE FOLLOW UNFOLLOW LIKE PIN UNPIN EXECUTE " +
    "RUN TRIGGER DISPATCH DEPLOY PAY CHARGE REFUND TRANSFER PURCHASE BUY ORDER ENABLE DISABLE START STOP " +
    "RESTART GRANT REVOKE SUBMIT RESOLVE RESET SAVE SYNC RESTORE DUPLICATE LOCK UNLOCK NOTIFY MUTE UNMUTE SNOOZE " +
    "COMPLETE RESPOND INVOKE CALL EMPTY REGISTER UNDO CONFIRM HIDE UNHIDE VOTE RESEND UPSERT SIGN"
  ).split(" "),
);
/** Words that only read. An action needs one of these, and none of the above, to go ahead. */
const READ_WORDS = new Set(
  "GET LIST FETCH SEARCH FIND READ RETRIEVE QUERY LOOKUP DESCRIBE COUNT VIEW CHECK".split(" "),
);

/** Whether one app action, by Composio's slug (GMAIL_FETCH_EMAILS, SLACK_SEND_MESSAGE), only reads. */
export function appActionReads(slug: string): boolean {
  const words = slug.toUpperCase().split(/[^A-Z0-9]+/u);
  if (words.some((word) => WRITE_WORDS.has(word))) return false;
  return words.some((word) => READ_WORDS.has(word));
}

/** Whether a call to the connected apps' server only reads, from the tool's name and its arguments. */
export function appsCallReads(tool: string, params: Record<string, unknown> | undefined): boolean {
  const name = tool.replace(/^mcp__.+?__/u, "").toUpperCase();
  if (LOOKUPS.has(name)) return true;
  const args = params ?? {};
  if (name === "COMPOSIO_MANAGE_CONNECTIONS") {
    // Listing accounts, or making a sign-in link the person still has to open, changes nothing.
    const toolkits = Array.isArray(args.toolkits) ? args.toolkits : [];
    return toolkits.every((toolkit) => {
      const action = (toolkit as { action?: unknown } | null)?.action ?? "add";
      return action === "list" || action === "add";
    });
  }
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = Array.isArray(args.tools) ? args.tools : [];
    return (
      tools.length > 0 &&
      tools.every((entry) => {
        const slug = (entry as { tool_slug?: unknown } | null)?.tool_slug;
        return typeof slug === "string" && appActionReads(slug);
      })
    );
  }
  if (name === "COMPOSIO_PROXY_EXECUTE") return String(args.method ?? "GET").toUpperCase() === "GET";
  // Running code in Composio's sandbox, managing skills, and anything unknown: the person decides.
  return false;
}

/** The tool name and arguments in an approval request, from Codex's or Claude Code's shape. */
export function approvalCall(payload: Record<string, unknown>): { tool: string; params?: Record<string, unknown> } {
  const meta = payload._meta as { tool_name?: unknown; tool_params?: unknown } | undefined;
  const tool = [meta?.tool_name, payload.toolName, payload.tool_name].find(
    (value): value is string => typeof value === "string",
  );
  const params = [meta?.tool_params, payload.input, payload.arguments].find(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return { tool: tool ?? "", ...(params ? { params } : {}) };
}

/** What a held call does, in words for the person's card: which apps, which actions, and the details that matter. */
export function describeAppsCall(
  tool: string,
  params: Record<string, unknown> | undefined,
): { apps: string; actions: string; details: string } {
  const name = tool.replace(/^mcp__.+?__/u, "").toUpperCase();
  const args = params ?? {};
  const show = (value: unknown) => clip(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL" && Array.isArray(args.tools)) {
    const tools = args.tools as { tool_slug?: unknown; arguments?: unknown }[];
    const slugs = tools.map((entry) => (typeof entry?.tool_slug === "string" ? entry.tool_slug : "?"));
    const apps = [...new Set(slugs.map(appOf))].join(", ");
    const changing = tools.filter((entry) => typeof entry?.tool_slug !== "string" || !appActionReads(entry.tool_slug));
    return {
      apps,
      actions: slugs.map(readable).join(", "),
      details: changing
        .map((entry) => `${readable(String(entry.tool_slug))}: ${show(entry.arguments ?? {})}`)
        .join("\n"),
    };
  }
  if (name === "COMPOSIO_REMOTE_WORKBENCH" || name === "COMPOSIO_REMOTE_BASH_TOOL")
    return {
      apps: "Composio's workbench (it can reach every connected app)",
      actions: name === "COMPOSIO_REMOTE_BASH_TOOL" ? "Run a command" : "Run code",
      details: show(args.code_to_execute ?? args.command ?? args),
    };
  if (name === "COMPOSIO_PROXY_EXECUTE")
    return {
      apps: String(args.toolkit_slug ?? "an app"),
      actions: `${String(args.method ?? "GET").toUpperCase()} ${String(args.endpoint ?? "")}`.trim(),
      details: show(args.body ?? args.parameters ?? {}),
    };
  if (name === "COMPOSIO_MANAGE_CONNECTIONS")
    return {
      apps: "Connected apps",
      actions: "Remove or rename a connected account",
      details: show(args.toolkits ?? args),
    };
  return { apps: appOf(name), actions: readable(name), details: show(args) };
}

/** Where each email action keeps the parts the person can change on its card. */
const EMAIL_ACTIONS: Record<string, { to: string; cc: string; bcc: string; subject?: string; body: string }> = {
  GMAIL_SEND_EMAIL: { to: "recipient_email", cc: "cc", bcc: "bcc", subject: "subject", body: "body" },
  GMAIL_CREATE_EMAIL_DRAFT: { to: "recipient_email", cc: "cc", bcc: "bcc", subject: "subject", body: "body" },
  GMAIL_REPLY_TO_THREAD: { to: "recipient_email", cc: "cc", bcc: "bcc", body: "message_body" },
};

/**
 * Arguments that change neither who gets an email nor what it says. Any other argument with a value (more
 * recipients, attachments, a sender) means the email card could hide something, so the call gets the plain card
 * that shows every argument instead.
 */
const QUIET_EMAIL_ARGS = new Set(["user_id", "is_html", "include_signature", "thread_id"]);

function onlyShownArgs(slug: string, args: Record<string, unknown>): boolean {
  const at = EMAIL_ACTIONS[slug];
  if (!at) return false;
  const shown = new Set([at.to, at.cc, at.bcc, at.subject, at.body].filter(Boolean));
  return Object.entries(args).every(
    ([key, value]) =>
      shown.has(key) ||
      QUIET_EMAIL_ARGS.has(key) ||
      value === null ||
      value === undefined ||
      value === "" ||
      value === false ||
      (Array.isArray(value) && value.length === 0),
  );
}

/** The one email action a call makes, if that is all it does: where it sits in the call, and its arguments. */
function emailStep(
  tool: string,
  params: Record<string, unknown> | undefined,
): { slug: string; args: Record<string, unknown>; index: number | undefined } | undefined {
  const name = tool.replace(/^mcp__.+?__/u, "").toUpperCase();
  const args = params ?? {};
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = Array.isArray(args.tools) ? (args.tools as { tool_slug?: unknown; arguments?: unknown }[]) : [];
    const changing = tools
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => typeof entry?.tool_slug !== "string" || !appActionReads(entry.tool_slug));
    const only = changing.length === 1 ? changing[0] : undefined;
    const slug = typeof only?.entry.tool_slug === "string" ? only.entry.tool_slug.toUpperCase() : "";
    const inner = only?.entry.arguments;
    if (!only || !EMAIL_ACTIONS[slug] || typeof inner !== "object" || inner === null || Array.isArray(inner))
      return undefined;
    const innerArgs = inner as Record<string, unknown>;
    return onlyShownArgs(slug, innerArgs) ? { slug, args: innerArgs, index: only.index } : undefined;
  }
  return onlyShownArgs(name, args) ? { slug: name, args, index: undefined } : undefined;
}

const listText = (value: unknown): string =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string").join(", ")
    : typeof value === "string"
      ? value
      : "";

/** The email a held call would send, as the card shows it for editing, or undefined when it is not one email. */
export function appsCallEmail(tool: string, params: Record<string, unknown> | undefined): AppDraftEmail | undefined {
  const step = emailStep(tool, params);
  const at = step ? EMAIL_ACTIONS[step.slug] : undefined;
  if (!step || !at) return undefined;
  return {
    to: listText(step.args[at.to]),
    cc: listText(step.args[at.cc]),
    bcc: listText(step.args[at.bcc]),
    subject: at.subject ? listText(step.args[at.subject]) : "",
    body: listText(step.args[at.body]),
  };
}

const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u;
const addresses = (value: string): string[] =>
  value
    .split(/[,;\s]+/u)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * The call with the person's changes to its email, or undefined when the changes are not a sendable email.
 * Only the address lines (To, Cc, Bcc), subject and body can change; everything else stays as the agent asked.
 */
export function withEmailEdits(
  tool: string,
  params: Record<string, unknown> | undefined,
  edits: unknown,
): Record<string, unknown> | undefined {
  const step = emailStep(tool, params);
  const at = step ? EMAIL_ACTIONS[step.slug] : undefined;
  if (!step || !at || !params || typeof edits !== "object" || edits === null) return undefined;
  const edit = edits as Partial<Record<keyof AppDraftEmail, unknown>>;
  const field = (key: keyof AppDraftEmail, max: number): string | undefined => {
    const value = edit[key];
    return typeof value === "string" && value.length <= max ? value : undefined;
  };
  const to = field("to", 2_000);
  const cc = field("cc", 2_000) ?? "";
  const bcc = field("bcc", 2_000) ?? "";
  const subject = field("subject", 1_000) ?? "";
  const body = field("body", 200_000);
  if (to === undefined || body === undefined) return undefined;
  const toList = addresses(to);
  const ccList = addresses(cc);
  const bccList = addresses(bcc);
  if (toList.length !== 1 || ![...toList, ...ccList, ...bccList].every((address) => ADDRESS.test(address)))
    return undefined;
  const args: Record<string, unknown> = { ...step.args, [at.to]: toList[0], [at.body]: body };
  // Exactly the copies the person saw on the card: a list they cleared is removed, never kept from the agent's call.
  for (const [key, list] of [
    [at.cc, ccList],
    [at.bcc, bccList],
  ] as const) {
    if (list.length > 0) args[key] = list;
    else delete args[key];
  }
  if (at.subject) args[at.subject] = subject;
  if (step.index === undefined) return args;
  const tools = [...(params.tools as unknown[])];
  tools[step.index] = { ...(tools[step.index] as object), arguments: args };
  return { ...params, tools };
}

/** GMAIL_SEND_EMAIL → Gmail. */
function appOf(slug: string): string {
  const head = slug.split("_")[0] ?? slug;
  return head.charAt(0) + head.slice(1).toLowerCase();
}

/** GMAIL_SEND_EMAIL → "Gmail: send email". */
function readable(slug: string): string {
  const [head = "", ...rest] = slug.split("_");
  return `${appOf(head)}: ${rest.join(" ").toLowerCase()}`;
}

function clip(text: string): string {
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}
