import { describe, expect, it } from "vitest";

import {
  appActionReads,
  approvalCall,
  appsCallEmail,
  appsCallReads,
  describeAppsCall,
  withEmailEdits,
} from "./appsPolicy.js";

describe("appsPolicy", () => {
  it("tells reading app actions from ones that change something", () => {
    for (const slug of ["GMAIL_FETCH_EMAILS", "GMAIL_LIST_THREADS", "GITHUB_GET_A_REPOSITORY", "SLACK_SEARCH_MESSAGES"])
      expect(appActionReads(slug), slug).toBe(true);
    for (const slug of [
      "GMAIL_SEND_EMAIL",
      "GMAIL_FORWARD_MESSAGE",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_MOVE_TO_TRASH",
      "SLACK_POST_MESSAGE",
      "GITHUB_DELETE_A_REPOSITORY",
      "STRIPE_CREATE_REFUND",
      // Reads and writes in one name: it changes something.
      "GMAIL_FETCH_AND_DELETE",
      // A read word next to a change verb that is easy to miss: still held.
      "GMAIL_FETCH_AND_RESEND",
      "GOOGLESHEETS_FIND_AND_UPSERT_ROWS",
      "JIRA_SEARCH_AND_RESOLVE_ISSUES",
      "GOOGLEDRIVE_FIND_AND_RESTORE_FILE",
      // Neither: unknown, so it asks.
      "NOTION_DO_THING",
    ])
      expect(appActionReads(slug), slug).toBe(false);
  });

  it("lets lookups and read-only batches through, and holds sends, code and removals", () => {
    expect(appsCallReads("COMPOSIO_SEARCH_TOOLS", {})).toBe(true);
    expect(appsCallReads("mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS", {})).toBe(true);
    expect(appsCallReads("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] })).toBe(true);
    expect(
      appsCallReads("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "GMAIL_SEND_EMAIL" }],
      }),
    ).toBe(false);
    expect(appsCallReads("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] })).toBe(false);
    expect(appsCallReads("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print(1)" })).toBe(false);
    expect(appsCallReads("COMPOSIO_REMOTE_BASH_TOOL", { command: "ls" })).toBe(false);
    expect(appsCallReads("COMPOSIO_PROXY_EXECUTE", { method: "GET" })).toBe(true);
    expect(appsCallReads("COMPOSIO_PROXY_EXECUTE", { method: "POST" })).toBe(false);
    expect(appsCallReads("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: "gmail", action: "list" }] })).toBe(true);
    expect(appsCallReads("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: "gmail" }] })).toBe(true);
    expect(
      appsCallReads("COMPOSIO_MANAGE_CONNECTIONS", {
        toolkits: [{ name: "gmail", action: "remove", account_id: "a" }],
      }),
    ).toBe(false);
    expect(appsCallReads("COMPOSIO_MANAGE_SKILL", {})).toBe(false);
    expect(appsCallReads("SOMETHING_NEW", {})).toBe(false);
  });

  it("reads the call from Codex's and Claude Code's approval shapes", () => {
    expect(approvalCall({ _meta: { tool_name: "COMPOSIO_SEARCH_TOOLS", tool_params: { a: 1 } } })).toEqual({
      tool: "COMPOSIO_SEARCH_TOOLS",
      params: { a: 1 },
    });
    expect(approvalCall({ toolName: "mcp__composio__X", input: { b: 2 } })).toEqual({
      tool: "mcp__composio__X",
      params: { b: 2 },
    });
  });
});

describe("describeAppsCall", () => {
  it("names the app, the action and the details the person decides on", () => {
    expect(
      describeAppsCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.c" } }],
      }),
    ).toEqual({
      apps: "Gmail",
      actions: "Gmail: fetch emails, Gmail: send email",
      details: expect.stringContaining("a@b.c"),
    });
    expect(describeAppsCall("mcp__composio__COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print(1)" })).toMatchObject(
      {
        actions: "Run code",
        details: "print(1)",
      },
    );
  });
});

describe("email drafts", () => {
  const call = {
    tools: [
      { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
      {
        tool_slug: "GMAIL_SEND_EMAIL",
        arguments: { recipient_email: "a@b.co", subject: "Hi", body: "Yo", user_id: "me" },
      },
    ],
  };

  it("reads the one email a call would send", () => {
    expect(appsCallEmail("COMPOSIO_MULTI_EXECUTE_TOOL", call)).toEqual({
      to: "a@b.co",
      cc: "",
      bcc: "",
      subject: "Hi",
      body: "Yo",
    });
    expect(
      appsCallEmail("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "SLACK_POST_MESSAGE" }] }),
    ).toBeUndefined();
  });

  it("changes only the address lines, subject and body, and refuses an unsendable email", () => {
    const edited = withEmailEdits("COMPOSIO_MULTI_EXECUTE_TOOL", call, {
      to: "c@d.co",
      cc: "e@f.co, g@h.co",
      subject: "New",
      body: "Changed",
      user_id: "someone-else",
    }) as { tools: { arguments: Record<string, unknown> }[] };
    expect(edited.tools[0]).toEqual(call.tools[0]);
    expect(edited.tools[1]?.arguments).toEqual({
      recipient_email: "c@d.co",
      cc: ["e@f.co", "g@h.co"],
      subject: "New",
      body: "Changed",
      user_id: "me",
    });
    expect(withEmailEdits("COMPOSIO_MULTI_EXECUTE_TOOL", call, { to: "not an address", body: "x" })).toBeUndefined();
    expect(withEmailEdits("COMPOSIO_MULTI_EXECUTE_TOOL", call, { to: "a@b.co, c@d.co", body: "x" })).toBeUndefined();
  });
});

describe("email drafts never hide a recipient", () => {
  const send = (args: Record<string, unknown>) => ({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: args }] });

  it("shows a Bcc on the card, and keeps only the Bcc the person saw", () => {
    const call = send({ recipient_email: "a@b.co", bcc: ["hidden@evil.co"], subject: "Hi", body: "Yo" });
    expect(appsCallEmail("COMPOSIO_MULTI_EXECUTE_TOOL", call)).toMatchObject({ bcc: "hidden@evil.co" });
    // The person cleared it: it is gone from what runs, not kept from the agent's call.
    const cleared = withEmailEdits("COMPOSIO_MULTI_EXECUTE_TOOL", call, {
      to: "a@b.co",
      cc: "",
      bcc: "",
      subject: "Hi",
      body: "Yo",
    }) as { tools: { arguments: Record<string, unknown> }[] };
    expect(cleared.tools[0]?.arguments).not.toHaveProperty("bcc");
    // An edit that leaves out the Bcc line entirely removes it too.
    const omitted = withEmailEdits("COMPOSIO_MULTI_EXECUTE_TOOL", call, { to: "a@b.co", body: "Yo" }) as {
      tools: { arguments: Record<string, unknown> }[];
    };
    expect(omitted.tools[0]?.arguments).not.toHaveProperty("bcc");
  });

  it("gives an email with anything else that could add a recipient or a file the plain card instead", () => {
    for (const extra of [{ extra_recipients: ["x@y.co"] }, { attachment: { name: "a.pdf" } }, { from_email: "x@y.co" }])
      expect(
        appsCallEmail("COMPOSIO_MULTI_EXECUTE_TOOL", send({ recipient_email: "a@b.co", body: "Yo", ...extra })),
      ).toBeUndefined();
    // Settings that change neither who gets it nor what it says keep the email card.
    expect(
      appsCallEmail(
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        send({ recipient_email: "a@b.co", body: "Yo", user_id: "me", include_signature: false, cc: [] }),
      ),
    ).toMatchObject({ to: "a@b.co" });
  });
});
