import { describe, expect, it } from "vitest";

import { MOBILE_MCP_TOOLS } from "../mcp.js";
import { MOBILE_DEV_INSTRUCTIONS } from "../devTools.js";

describe("crash and build tools", () => {
  it("adds mobile_crashes and mobile_build_brief as read-only tools", () => {
    const crashes = MOBILE_MCP_TOOLS.find((tool) => tool.name === "mobile_crashes");
    const brief = MOBILE_MCP_TOOLS.find((tool) => tool.name === "mobile_build_brief");
    expect(crashes).toMatchObject({ title: "Read app crashes", action: "mobilecrashes", readOnly: true });
    expect(crashes?.description).toMatch(/^Crashes and ANRs ZLI caught in the device log while you used it/u);
    expect(brief).toMatchObject({ title: "Explain a build failure", action: "mobilebuildbrief", readOnly: true });
    expect(Object.keys(brief?.properties ?? {})).toEqual(["log", "logPath"]);
    expect(MOBILE_DEV_INSTRUCTIONS).toContain("call mobile_crashes");
    expect(MOBILE_DEV_INSTRUCTIONS).toContain("call mobile_build_brief");
  });
});
