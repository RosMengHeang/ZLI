import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MobileSettingsStore } from "./MobileSettingsStore.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function settingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-mobile-settings-"));
  temps.push(dir);
  return join(dir, "nested", "mobile-settings.json");
}

describe("mobile settings", () => {
  it("turns agent tools on until the person changes it", async () => {
    expect(await new MobileSettingsStore(await settingsPath()).get()).toEqual({ agentTools: true, crashWatch: true });
  });

  it("saves a change and reads it back in a new store", async () => {
    const path = await settingsPath();
    expect(await new MobileSettingsStore(path).set({ agentTools: false })).toEqual({
      agentTools: false,
      crashWatch: true,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ agentTools: false, crashWatch: true });
    expect(await new MobileSettingsStore(path).get()).toEqual({ agentTools: false, crashWatch: true });
  });

  it("falls back to the defaults when the file is not valid", async () => {
    const path = await settingsPath();
    await new MobileSettingsStore(path).set({ agentTools: false });
    await writeFile(path, "{ not json");
    expect(await new MobileSettingsStore(path).get()).toEqual({ agentTools: true, crashWatch: true });
  });

  it("keeps the Mac for iPhone simulators, clears it with an empty address, and refuses one ssh would misread", async () => {
    const path = await settingsPath();
    expect(await new MobileSettingsStore(path).set({ iosRemoteHost: " dev@studio.local " })).toEqual({
      agentTools: true,
      crashWatch: true,
      iosRemoteHost: "dev@studio.local",
    });
    expect((await new MobileSettingsStore(path).get()).iosRemoteHost).toBe("dev@studio.local");
    await expect(new MobileSettingsStore(path).set({ iosRemoteHost: "-oProxyCommand=calc" })).rejects.toThrow();
    expect((await new MobileSettingsStore(path).set({ iosRemoteHost: "" })).iosRemoteHost).toBe("");
    expect((await new MobileSettingsStore(path).get()).iosRemoteHost).toBe("");
  });

  it("reads a file from an older version with the newer settings at their defaults", async () => {
    const path = await settingsPath();
    await new MobileSettingsStore(path).set({ agentTools: false });
    await writeFile(path, JSON.stringify({ agentTools: false }));
    expect(await new MobileSettingsStore(path).get()).toEqual({ agentTools: false, crashWatch: true });
  });
});
