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

const linearOff = { connected: false };
const respond = (command: Record<string, unknown>) => ({
  result: String(command.type).startsWith("issues.linear") ? linearOff : status,
});

describe("ForgesSection", () => {
  it("shows each forge's CLI, sign-in, and what to do next", async () => {
    await renderWithRuntime(<ForgesSection />, respond);
    await act(async () => undefined);
    const rows = [...document.querySelectorAll('[aria-label="Forges"] .forge-row')].map((row) => row.textContent);
    expect(rows[0]).toContain("gh 2.98.0");
    expect(rows[0]).toContain("octo on github.com");
    expect(rows[0]).toContain("Connected");
    expect(rows[1]).toContain("Not signed in");
    expect(rows[1]).toContain("glab auth login");
    expect(rows[2]).toContain("Not installed");
    expect(rows[2]).toContain("Install");
    expect(document.querySelectorAll('[aria-label="Forges"] .connector-logo svg')).toHaveLength(3);
  });

  it("checks again on Rescan", async () => {
    const commands = await renderWithRuntime(<ForgesSection />, respond);
    await act(async () => undefined);
    const rescan = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Rescan"));
    await act(async () => rescan?.click());
    expect(commands.map((command) => command.type).filter((type) => String(type).startsWith("forges"))).toEqual([
      "forges.status",
      "forges.rescan",
    ]);
  });

  it("sets up Linear issues on the same page", async () => {
    const commands = await renderWithRuntime(<ForgesSection />, (command) =>
      command.type === "issues.linear.connect"
        ? { result: { connected: true, viewer: { name: "Sam" } } }
        : respond(command),
    );
    await act(async () => undefined);
    const linear = document.querySelector('[aria-label="Issue trackers"] .forge-row');
    expect(linear?.textContent).toContain("Not connected");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Linear API key"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "lin_api_test");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input?.form?.requestSubmit());
    expect(commands.at(-1)).toMatchObject({ type: "issues.linear.connect", apiKey: "lin_api_test" });
    expect(document.querySelector('[aria-label="Issue trackers"] .forge-row')?.textContent).toContain(
      "Connected as Sam",
    );
  });
});
