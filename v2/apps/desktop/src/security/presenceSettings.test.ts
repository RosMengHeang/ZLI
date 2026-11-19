import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { presenceSettings, registerPresenceIpc } from "./presenceSettings.js";
import { parsePresenceStatus } from "./presenceStatus.js";
import { type KeychainCodec, secretsKey } from "./secretsKey.js";
import type { UserPresence } from "./userPresence.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const keychain: KeychainCodec = {
  available: async () => true,
  encrypt: async (text) => Buffer.from(text, "utf8").reverse(),
  decrypt: async (sealed) => Buffer.from(sealed).reverse().toString("utf8"),
};

const hello = (options: { cancel?: boolean; available?: boolean } = {}): UserPresence => ({
  available: async () => options.available ?? true,
  secret: async (challenge) =>
    options.cancel ? undefined : createHmac("sha256", "device").update(challenge).digest(),
});

async function setup(presence: UserPresence | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "zli-presence-ipc-"));
  folders.push(dir);
  const path = join(dir, "secrets-key.bin");
  const { key } = await secretsKey(path, keychain);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerPresenceIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    presenceSettings({ presence, codec: keychain, path, key: () => key }),
  );
  const call = async (channel: string) => handlers.get(`zli:security:presence-${channel}`)?.({});
  return { call, key };
}

describe("presence settings over IPC", () => {
  it("is unsupported without a Hello layer (macOS, Linux)", async () => {
    const { call } = await setup(undefined);
    expect(await call("status")).toEqual({ status: "unsupported" });
  });

  it("is unavailable when Hello isn't set up, and turning on does nothing", async () => {
    const { call } = await setup(hello({ available: false }));
    expect(await call("status")).toEqual({ status: "unavailable" });
    expect((await call("on")) as { status: string }).toMatchObject({ status: "unavailable" });
  });

  it("turns on and off, and never sends the key to the page", async () => {
    const { call, key } = await setup(hello());
    expect(await call("status")).toEqual({ status: "off" });
    const on = await call("on");
    expect(on).toEqual({ status: "on" });
    expect(JSON.stringify(on)).not.toContain(key);
    expect(await call("off")).toEqual({ status: "off" });
  });

  it("stays off with an error when the user cancels the Hello prompt", async () => {
    const { call } = await setup(hello({ cancel: true }));
    expect(await call("on")).toEqual({ status: "off", error: "Windows Hello didn't confirm it was you, so this stays off." });
  });

  it("the preload keeps only the status and error", () => {
    expect(parsePresenceStatus({ status: "on", key: "secret" })).toEqual({ status: "on" });
    expect(parsePresenceStatus({ status: "weird" })).toEqual({ status: "unsupported" });
  });
});
