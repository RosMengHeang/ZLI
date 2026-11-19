import { describe, expect, it } from "vitest";

import { stepAfterAddingProject } from "./addedProject.js";

describe("stepAfterAddingProject", () => {
  it("opens a new chat instead of the agent dialog", () => {
    expect(stepAfterAddingProject({ startAgent: true, mode: "chat", hasAgent: true })).toBe("chat");
    expect(stepAfterAddingProject({ startAgent: true, mode: undefined, hasAgent: true })).toBe("chat");
  });

  it("only selects the project when added from Settings", () => {
    expect(stepAfterAddingProject({ startAgent: false, mode: "chat", hasAgent: true })).toBe("select");
  });

  it("keeps the dialog for Terminal mode and when no agent is installed", () => {
    expect(stepAfterAddingProject({ startAgent: true, mode: "terminal", hasAgent: true })).toBe("dialog");
    expect(stepAfterAddingProject({ startAgent: true, mode: "chat", hasAgent: false })).toBe("dialog");
  });
});
