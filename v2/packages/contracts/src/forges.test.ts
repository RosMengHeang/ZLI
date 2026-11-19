import { describe, expect, it } from "vitest";

import { ForgeStatusResult } from "./forges.js";
import { RuntimeCommand } from "./rpc.js";

describe("forge contracts", () => {
  it("reads the forge commands as runtime commands", () => {
    expect(RuntimeCommand.parse({ type: "forges.status" })).toEqual({ type: "forges.status" });
    expect(RuntimeCommand.parse({ type: "forges.rescan" })).toEqual({ type: "forges.rescan" });
  });

  it("reads a forge status with and without accounts", () => {
    const status = ForgeStatusResult.parse({
      checkedAt: "2026-11-17T10:00:00.000Z",
      forges: [
        {
          kind: "github",
          label: "GitHub",
          cli: "gh",
          state: "ready",
          version: "2.98.0",
          minimumVersion: "2.40.0",
          accounts: [{ host: "github.com", login: "octo" }],
          signInCommand: "gh auth login",
          installUrl: "https://cli.github.com/",
        },
        {
          kind: "gitea",
          label: "Gitea",
          cli: "tea",
          state: "missing",
          minimumVersion: "0.9.0",
          accounts: [],
          signInCommand: "tea login add",
          installUrl: "https://gitea.com/gitea/tea",
        },
      ],
    });
    expect(status.forges.map((forge) => forge.state)).toEqual(["ready", "missing"]);
  });
});
