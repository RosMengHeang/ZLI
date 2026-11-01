import { describe, expect, it } from "vitest";
import { projectFacts } from "../../mobile/dev/doctor/facts.js";
import { fixtureFiles } from "../../mobile/dev/doctor/testFixtures.js";
import { createTestDevHost } from "../../mobile/dev/testHost.js";
import { createMobileMcpServer } from "../mcp.js";
import { doctorTools, formatFacts } from "./doctor.js";

async function facts(fixture: string) {
  const result = await projectFacts(createTestDevHost({ files: fixtureFiles(fixture) }), "wt-1");
  if (!result) throw new Error("no facts");
  return result;
}

describe("mobile_doctor", () => {
  it("is listed by the zli-mobile server and asks agents to read it before changing versions", async () => {
    const mcp = createMobileMcpServer(async () => ({}));
    const listed = (await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    };
    expect(listed.result.tools.find((tool) => tool.name === "mobile_doctor")).toBeDefined();
    expect(doctorTools.instructions).toContain("call mobile_doctor");
  });

  it("tells the agent the versions, the problems, and to propose fixes instead of running them", async () => {
    const text = formatFacts(await facts("expo55-newarch-off"));
    expect(text).toContain("Stack: expo.");
    expect(text).toContain("- Expo SDK package (expo): 55.0.4");
    expect(text).toContain("- React Native: 0.83.1");
    expect(text).toContain("error: ");
    expect(text).toContain(
      "Fix: npx expo install expo-dev-client. Propose it with mobile_propose; do not run it yourself.",
    );
    expect(text).toContain("Expo checks have not run.");
    expect(text).toContain("Do not create or change certificates");
    expect(text).toContain("AGENTS.md has no ZLI mobile notes.");
  });

  it("names the app folder in a monorepo and says when there is no app", async () => {
    expect(formatFacts(await facts("monorepo-apps-mobile"))).toContain("Stack: expo, in apps/mobile.");
    const none = await projectFacts(createTestDevHost({ files: { "/repo/app/README.md": "hi" } }), "wt-1");
    expect(formatFacts(none as NonNullable<typeof none>)).toMatch(/^No mobile app found/u);
  });

  it("formats only its own action and well-formed facts", async () => {
    expect(doctorTools.format?.("mobiledoctor", await facts("rn-bare-0.85"))?.content[0]).toMatchObject({
      type: "text",
    });
    expect(doctorTools.format?.("mobiledoctor", { nope: true })).toBeUndefined();
    expect(doctorTools.format?.("mobiletap", {})).toBeUndefined();
  });
});
