// @vitest-environment jsdom

import type { IssueDetail } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  issueBranchName,
  issueLinkFor,
  issuePrompt,
  issueSlug,
  rememberIssueLink,
  updatedLabel,
  withIssueReference,
} from "./issueStart.js";

const ISSUE: IssueDetail = {
  source: "github",
  key: "123",
  reference: "#123",
  title: "Fix the login button on Safari (again!)",
  state: "open",
  url: "https://github.com/acme/app/issues/123",
  labels: [{ name: "bug" }],
  assignees: [],
  body: "Clicking does nothing.",
  comments: [
    { author: "bob", body: "Seen it too.", createdAt: "2026-01-02T10:00:00Z" },
    { author: "carol", body: "  ", createdAt: "2026-01-03T10:00:00Z" },
  ],
};

const LINEAR = { source: "linear" as const, key: "ENG-7", reference: "ENG-7", title: "Crash on save" };

describe("issueSlug", () => {
  it("names the issue and the first words of its title", () => {
    expect(issueSlug(ISSUE)).toBe("issue-123-fix-the-login-button-on-safari-again");
    expect(issueSlug(LINEAR)).toBe("eng-7-crash-on-save");
  });

  it("keeps the slug short and plain", () => {
    expect(issueSlug({ ...LINEAR, title: "Café ünïcode — ".repeat(10) }).length).toBeLessThanOrEqual(46);
    expect(issueSlug({ ...LINEAR, title: "!!!" })).toBe("eng-7");
  });
});

describe("issueBranchName", () => {
  const now = new Date(2026, 0, 2);
  const random = () => "k3f9";

  it("uses the slug alone with the default template", () => {
    expect(issueBranchName("{agent}-{random}", "codex", ISSUE, now, random)).toBe(
      "issue-123-fix-the-login-button-on-safari-again",
    );
  });

  it("keeps the template's folder", () => {
    expect(issueBranchName("zli/{date}-{agent}", "codex", LINEAR, now, random)).toBe("zli/eng-7-crash-on-save");
    expect(issueBranchName("{agent}/{random}", "claude-code", LINEAR, now, random)).toBe("claude/eng-7-crash-on-save");
  });

  it("puts the issue where the template asks", () => {
    expect(issueBranchName("{agent}/{issue}-{random}", "codex", LINEAR, now, random)).toBe(
      "codex/eng-7-crash-on-save-k3f9",
    );
  });
});

describe("issuePrompt", () => {
  it("includes the title, link, body, comments, and the closing note", () => {
    expect(issuePrompt(ISSUE)).toBe(
      [
        "Work on GitHub issue #123: Fix the login button on Safari (again!)",
        "https://github.com/acme/app/issues/123",
        "",
        "Clicking does nothing.",
        "",
        "Latest comment:",
        "",
        "bob on 2026-01-02:",
        "Seen it too.",
        "",
        "When you finish, mention Fixes #123 in the PR.",
      ].join("\n"),
    );
  });

  it("says when there is no description and keeps the last five comments", () => {
    const comments = Array.from({ length: 8 }, (_, index) => ({ body: `comment ${index}` }));
    const prompt = issuePrompt({
      ...ISSUE,
      ...LINEAR,
      url: "https://linear.app/acme/issue/ENG-7",
      body: "",
      comments,
    });
    expect(prompt).toContain("Work on Linear issue ENG-7: Crash on save");
    expect(prompt).toContain("The issue has no description.");
    expect(prompt).toContain("Latest 5 comments:");
    expect(prompt).not.toContain("comment 2");
    expect(prompt).toContain("Someone:\ncomment 7");
    expect(prompt.endsWith("mention Fixes ENG-7 in the PR.")).toBe(true);
  });
});

describe("withIssueReference", () => {
  it("adds Fixes once", () => {
    expect(withIssueReference("- Add a greeting", { reference: "#123" })).toBe("- Add a greeting\n\nFixes #123");
    expect(withIssueReference("", { reference: "ENG-7" })).toBe("Fixes ENG-7");
    expect(withIssueReference("Closes #123", { reference: "#123" })).toBe("Closes #123");
    expect(withIssueReference("Part of eng-7", { reference: "ENG-7" })).toBe("Part of eng-7");
    expect(withIssueReference("See #1234", { reference: "#123" })).toBe("See #1234\n\nFixes #123");
    expect(withIssueReference("body", undefined)).toBe("body");
  });
});

describe("issue links", () => {
  afterEach(() => window.localStorage.clear());

  it("remembers the issue per worktree", () => {
    rememberIssueLink("w1", {
      source: "github",
      key: "123",
      reference: "#123",
      title: "t",
      url: ISSUE.url,
      sessionId: "s1",
      linkedAt: "2026-01-01T00:00:00Z",
    });
    expect(issueLinkFor("w1")).toMatchObject({ reference: "#123", sessionId: "s1" });
    expect(issueLinkFor("w2")).toBeUndefined();
  });

  it("ignores damaged storage", () => {
    window.localStorage.setItem("zli.issueLinks.v1", JSON.stringify({ w1: { source: "jira" }, w2: "x" }));
    expect(issueLinkFor("w1")).toBeUndefined();
    window.localStorage.setItem("zli.issueLinks.v1", "{");
    expect(issueLinkFor("w1")).toBeUndefined();
  });
});

describe("updatedLabel", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  it("is short", () => {
    expect(updatedLabel("2026-01-10T11:30:00Z", now)).toBe("30m");
    expect(updatedLabel("2026-01-10T07:00:00Z", now)).toBe("5h");
    expect(updatedLabel("2026-01-07T12:00:00Z", now)).toBe("3d");
    expect(updatedLabel("2025-06-01T00:00:00Z", now)).toBe("2025-06-01");
    expect(updatedLabel(undefined, now)).toBe("");
  });
});
