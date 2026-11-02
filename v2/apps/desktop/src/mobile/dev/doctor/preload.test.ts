import { describe, expect, it } from "vitest";

import type { PreloadIpc } from "../preloadIpc.js";
import { createDoctorApi } from "./preload.js";

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

const facts = {
  worktreeId: "wt-1",
  appDir: ".",
  stack: "expo",
  versions: { expo: "56.0.3" },
  findings: [],
  fingerprint: "abc",
  checkedAt: "2026-01-02T03:04:05.000Z",
};

describe("the doctor preload API", () => {
  it("sends parsed input on the doctor channels and parses the answers", async () => {
    const { fake, calls } = ipc(facts);
    const { doctor } = createDoctorApi(fake);
    expect(await doctor.check("wt-1", { refresh: true })).toEqual(facts);
    await doctor.check("wt-1");
    expect(calls).toEqual([
      { channel: "zli:mobile:doctor:check", payload: { worktreeId: "wt-1", refresh: true } },
      { channel: "zli:mobile:doctor:check", payload: { worktreeId: "wt-1" } },
    ]);
    const blocks = ipc({ upToDate: true, file: "AGENTS.md" });
    expect(await createDoctorApi(blocks.fake).doctor.proposeBlock("wt-1")).toEqual({
      upToDate: true,
      file: "AGENTS.md",
    });
    expect(blocks.calls[0]?.channel).toBe("zli:mobile:doctor:propose-block");
  });

  it("rejects answers that do not match the contract", async () => {
    await expect(createDoctorApi(ipc({ stack: "expo" }).fake).doctor.check("wt-1")).rejects.toThrow();
  });
});
