// @vitest-environment jsdom

import type { ForgeCliStatus } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupRuntimeRenders, renderWithRuntime } from "../review/testRuntime.js";
import { ForgesSection } from "./ForgesSection.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

const forge = (extra: Partial<ForgeCliStatus> & Pick<ForgeCliStatus, "kind" | "label" | "cli">): ForgeCliStatus => ({
  state: "missing",
  minimumVersion: "1.0.0",
  accounts: [],
  signInCommand: `${extra.cli} auth login`,
  installUrl: "https://example.com/",
  ...extra,
});

const status = {
  checkedAt: "2026-11-17T10:00:00.000Z",
  forges: [
    forge({
      kind: "github",
      label: "GitHub",
      cli: "gh",
      state: "ready",
      version: "2.98.0",
      accounts: [{ host: "github.com", login: "octo" }],
    }),
    forge({ kind: "gitlab", label: "GitLab", cli: "glab", state: "signed_out", version: "1.46.0" }),
    forge({ kind: "gitea", label: "Gitea", cli: "tea" }),
  ],
};

describe("ForgesSection", () => {
  it("shows each forge's CLI, sign-in, and what to do next", async () => {
    await renderWithRuntime(<ForgesSection />, () => ({ result: status }));
    await act(async () => undefined);
    const rows = [...document.querySelectorAll(".forge-row")].map((row) => row.textContent);
    expect(rows[0]).toContain("gh 2.98.0");
    expect(rows[0]).toContain("octo on github.com");
    expect(rows[0]).toContain("Connected");
    expect(rows[1]).toContain("Not signed in");
    expect(rows[1]).toContain("glab auth login");
    expect(rows[2]).toContain("Not installed");
    expect(rows[2]).toContain("Install");
    expect(document.querySelectorAll(".forge-row .connector-logo svg")).toHaveLength(3);
  });

  it("checks again on Rescan", async () => {
    const commands = await renderWithRuntime(<ForgesSection />, () => ({ result: status }));
    await act(async () => undefined);
    const rescan = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Rescan"));
    await act(async () => rescan?.click());
    expect(commands.map((command) => command.type)).toEqual(["forges.status", "forges.rescan"]);
  });
});
