import { describe, expect, it } from "vitest";

import type { PreloadIpc } from "../preloadIpc.js";
import { createPackagesApi } from "./preload.js";

function ipc(answer: unknown) {
  const calls: { channel: string; payload: unknown }[] = [];
  const fake: PreloadIpc = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return answer;
    },
    on: () => () => {},
  };
  return { fake, calls };
}

describe("the package guard preload API", () => {
  it("sends parsed input, parses the answer, and refuses names that are not npm packages", async () => {
    const { fake, calls } = ipc({ verdicts: [] });
    const { packages } = createPackagesApi(fake);
    expect(await packages.check("wt-1", ["expo-camera"])).toEqual({ verdicts: [] });
    expect(calls).toEqual([
      { channel: "zli:mobile:packages:check", payload: { worktreeId: "wt-1", packages: ["expo-camera"] } },
    ]);
    await expect(packages.check("wt-1", ["$(curl evil)"])).rejects.toThrow();
    await expect(packages.proposeInstall("wt-1", [])).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
