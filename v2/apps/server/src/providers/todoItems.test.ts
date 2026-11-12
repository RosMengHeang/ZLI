import { describe, expect, it } from "vitest";

import { todoItems, toolActivity } from "./toolActivity.js";

describe("todoItems", () => {
  it("reads Claude's TodoWrite list", () => {
    expect(
      todoItems("TodoWrite", {
        todos: [
          { content: "Read the routes", status: "completed", activeForm: "Reading the routes" },
          { content: "Fix the route", status: "in_progress" },
          { content: "Run the tests", status: "pending" },
        ],
      }),
    ).toEqual([
      { text: "Read the routes", status: "completed" },
      { text: "Fix the route", status: "in_progress" },
      { text: "Run the tests", status: "pending" },
    ]);
  });

  it("reads Codex's plan steps and their camel-case statuses", () => {
    expect(
      todoItems("update_plan", {
        todos: [
          { step: "Look around", status: "completed" },
          { step: "Change it", status: "inProgress" },
        ],
      }),
    ).toEqual([
      { text: "Look around", status: "completed" },
      { text: "Change it", status: "in_progress" },
    ]);
  });

  it("reads a list written as text lines", () => {
    expect(todoItems("TodoWrite", { todos: "1. [completed] Read\n2. [in_progress] Edit\n- [pending] Test" })).toEqual([
      { text: "Read", status: "completed" },
      { text: "Edit", status: "in_progress" },
      { text: "Test", status: "pending" },
    ]);
  });

  it("leaves other calls and empty lists alone", () => {
    expect(todoItems("Bash", { todos: [{ content: "x", status: "pending" }] })).toBeUndefined();
    expect(todoItems("TodoWrite", { todos: [] })).toBeUndefined();
  });

  it("turns a todo call into the plan instead of a step", () => {
    const activity = toolActivity({
      callId: "call-1",
      name: "TodoWrite",
      status: "completed",
      input: {
        todos: [
          { content: "One", status: "completed" },
          { content: "Two", status: "pending" },
        ],
      },
    });
    expect(activity.title).toBe("Plan: 1 of 2 done");
    expect(activity.todos).toHaveLength(2);
  });
});
