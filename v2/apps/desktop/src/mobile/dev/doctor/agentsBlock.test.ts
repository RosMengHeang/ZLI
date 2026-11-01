import { PROPOSAL_BLOCK_END, PROPOSAL_BLOCK_START } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { createTestDevHost } from "../testHost.js";
import { proposeBlock, renderBlock } from "./agentsBlock.js";
import { projectFacts } from "./facts.js";
import { fixtureFiles } from "./testFixtures.js";

async function factsFor(host: ReturnType<typeof createTestDevHost>) {
  const facts = await projectFacts(host, "wt-1");
  if (!facts) throw new Error("no facts");
  return facts;
}

describe("the zli:mobile notes block", () => {
  it("lists the project's facts with no ports, dates, or this computer's tools, and is stable", async () => {
    const host = createTestDevHost({ files: fixtureFiles("expo56-devclient") });
    const facts = await factsFor(host);
    const block = renderBlock(facts);
    expect(block.split("\n").slice(0, 3)).toEqual([
      "### Mobile (written by ZLI; edit outside these markers)",
      "- Expo SDK 56 (react-native 0.85.1), development build (expo-dev-client), New Architecture on.",
      "- Install packages with `npx expo install <pkg>`, never plain `npm install`. Check new packages with the zli-mobile tool mobile_check_package first.",
    ]);
    expect(block).toContain("- Do not set newArchEnabled=false; this SDK cannot turn it off.");
    expect(block).toContain(`- Project versions fingerprint: ${facts.projectFingerprint}.`);
    expect(block).not.toMatch(/\b80\d\d\b|2026|java|node/iu);
    const other = createTestDevHost({
      files: fixtureFiles("expo56-devclient"),
      os: "macos",
      now: new Date("2027-05-06T00:00:00.000Z"),
    });
    expect(renderBlock(await factsFor(other))).toBe(block);
  });

  it("names the app folder and the package manager in a monorepo or bare app", async () => {
    const mono = renderBlock(await factsFor(createTestDevHost({ files: fixtureFiles("monorepo-apps-mobile") })));
    expect(mono).toContain("- The app is in `apps/mobile`; run its commands from there.");
    expect(mono).toContain("Expo Go from the App Store stops at SDK 54");
    const bare = renderBlock(await factsFor(createTestDevHost({ files: fixtureFiles("rn-bare-0.85") })));
    expect(bare).toContain("- React Native 0.85.1, New Architecture on.");
    expect(bare).toContain("`pnpm add <pkg>`");
    expect(bare).toContain("- Android build: Gradle 8.14.3, Android Gradle Plugin 8.7.2".replace("8.7.2", "8.10.1"));
    expect(bare).toContain("`pod install` must run in `ios`");
  });

  it("proposes a new AGENTS.md when there is no notes file, and writes it only on accept", async () => {
    const host = createTestDevHost({ files: fixtureFiles("expo56-devclient") });
    const result = await proposeBlock(host, "wt-1", await factsFor(host));
    expect(result).toMatchObject({ upToDate: false, file: "AGENTS.md" });
    const [proposal] = host.proposals.list("wt-1");
    expect(proposal).toMatchObject({
      source: "zli",
      sourceLabel: "From the project check",
      title: "Add mobile notes for agents",
      action: { kind: "file-block", file: "AGENTS.md", baseDigest: "absent" },
    });
    expect(host.files.has("/repo/app/AGENTS.md")).toBe(false);
    await host.proposals.accept(proposal?.proposalId as string);
    const written = host.files.get("/repo/app/AGENTS.md") ?? "";
    expect(written.startsWith(PROPOSAL_BLOCK_START)).toBe(true);
    expect(written).toContain(PROPOSAL_BLOCK_END);
    expect(await proposeBlock(host, "wt-1", await factsFor(host))).toEqual({ upToDate: true, file: "AGENTS.md" });
    expect((await factsFor(host)).notes).toEqual({ file: "AGENTS.md", state: "current" });
  });

  it("uses CLAUDE.md when only it exists, and appends after its text", async () => {
    const host = createTestDevHost({
      files: { ...fixtureFiles("expo56-devclient"), "/repo/app/CLAUDE.md": "# Rules\n\nBe brief.\n" },
    });
    const result = await proposeBlock(host, "wt-1", await factsFor(host));
    expect(result).toMatchObject({ upToDate: false, file: "CLAUDE.md" });
    await host.proposals.accept((result as { proposalId: string }).proposalId);
    expect(host.files.get("/repo/app/CLAUDE.md")).toMatch(/^# Rules\n\nBe brief\.\n\n<!-- zli:mobile:start -->\n/u);
  });

  it("prefers AGENTS.md, records its digest, and updates an outdated block in place", async () => {
    const host = createTestDevHost({
      files: {
        ...fixtureFiles("expo56-devclient"),
        "/repo/app/CLAUDE.md": "# Claude\n",
        "/repo/app/AGENTS.md": `# Agents\n\n${PROPOSAL_BLOCK_START}\n- Expo SDK 54.\n${PROPOSAL_BLOCK_END}\n\nMore.\n`,
      },
    });
    const facts = await factsFor(host);
    expect(facts.notes).toEqual({ file: "AGENTS.md", state: "outdated" });
    const result = await proposeBlock(host, "wt-1", facts);
    const [proposal] = host.proposals.list("wt-1");
    expect(proposal?.title).toBe("Update the mobile notes in AGENTS.md");
    expect(proposal?.action).toMatchObject({ baseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(await proposeBlock(host, "wt-1", facts)).toEqual(result);
    expect(host.proposals.list("wt-1")).toHaveLength(1);
    await host.proposals.accept((result as { proposalId: string }).proposalId);
    const text = host.files.get("/repo/app/AGENTS.md") ?? "";
    expect(text).toMatch(/^# Agents\n\n<!-- zli:mobile:start -->\n### Mobile/u);
    expect(text).toMatch(/<!-- zli:mobile:end -->\n\nMore\.\n$/u);
    expect(text).not.toContain("SDK 54");
  });

  it("refuses a worktree with no app", async () => {
    const host = createTestDevHost({ files: { "/repo/app/README.md": "hi" } });
    await expect(proposeBlock(host, "wt-1", await factsFor(host))).rejects.toThrow("No mobile app found");
  });
});
