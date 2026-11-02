import { describe, expect, it } from "vitest";

import { easProjectId } from "./push.js";

describe("easProjectId", () => {
  it("prefers the build's project, then app.json", () => {
    expect(easProjectId({ extra: { eas: { projectId: "from-app" } } }, { projectId: "from-build" })).toBe("from-build");
    expect(easProjectId({ extra: { eas: { projectId: "from-app" } } }, null)).toBe("from-app");
  });

  it("finds none in a project that has not run eas init", () => {
    expect(easProjectId({ extra: {} }, undefined)).toBeUndefined();
    expect(easProjectId(null, { projectId: " " })).toBeUndefined();
    expect(easProjectId({ extra: { eas: { projectId: 42 } } }, {})).toBeUndefined();
  });
});
