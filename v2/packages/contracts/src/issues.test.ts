import { describe, expect, it } from "vitest";

import { IssueKey } from "./issues.js";
import { RuntimeCommand } from "./rpc.js";

const PROJECT = "00000000-0000-4000-8000-000000000010";

describe("issue commands", () => {
  it("are runtime commands", () => {
    expect(
      RuntimeCommand.parse({ type: "issues.list", projectId: PROJECT, source: "github", assignee: "me" }),
    ).toMatchObject({ type: "issues.list", assignee: "me" });
    expect(RuntimeCommand.parse({ type: "issues.get", projectId: PROJECT, source: "linear", key: "ENG-12" })).toEqual({
      type: "issues.get",
      projectId: PROJECT,
      source: "linear",
      key: "ENG-12",
    });
    expect(RuntimeCommand.parse({ type: "issues.linear.status" })).toEqual({ type: "issues.linear.status" });
  });

  it("accept only issue numbers and identifiers as keys", () => {
    expect(IssueKey.safeParse("123").success).toBe(true);
    expect(IssueKey.safeParse("ENG-123").success).toBe(true);
    expect(IssueKey.safeParse("--repo=x").success).toBe(false);
    expect(IssueKey.safeParse("1; rm").success).toBe(false);
  });

  it("refuse API keys with spaces or control characters", () => {
    expect(RuntimeCommand.safeParse({ type: "issues.linear.connect", apiKey: "lin_api_x y" }).success).toBe(false);
    expect(RuntimeCommand.safeParse({ type: "issues.linear.connect", apiKey: "lin_api_xy" }).success).toBe(true);
  });
});
