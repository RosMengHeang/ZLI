import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fromBase64Url, webCryptoRandomBytes as random, toBase64Url } from "@zli-v2/remote-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttemptLimiter } from "./AttemptLimiter.js";
import { lanAddresses } from "./lanAddresses.js";
import { MobileAccessStore, type SecretCodec } from "./MobileAccessStore.js";
import { PAIRING_TTL_MS, PairingWindow } from "./PairingWindow.js";

const codec: SecretCodec = {
  seal: (secret) => `sealed:${toBase64Url(secret)}`,
  open: (text) => fromBase64Url(text.slice(7)),
};

describe("MobileAccessStore", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zli-mobile-store-"));
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it("starts off with nothing paired and keeps the same key across loads", async () => {
    const path = join(directory, "mobile.json");
    const store = new MobileAccessStore(path, codec, random);
    await store.load();
    expect(store.enabled).toBe(false);
    expect(store.devices()).toEqual([]);
    const key = await store.keyPair();
    await store.setEnabled(true);
    await store.setPort(47_321);

    const reloaded = new MobileAccessStore(path, codec, random);
    await reloaded.load();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.port).toBe(47_321);
    expect((await reloaded.keyPair()).publicKey).toEqual(key.publicKey);
    expect(await readFile(path, "utf8")).toContain("sealed:");
  });

  it("drops paired phones when the sealed key can no longer be opened", async () => {
    const path = join(directory, "mobile.json");
    const store = new MobileAccessStore(path, codec, random);
    await store.load();
    const key = await store.keyPair();
    await store.addDevice({
      deviceId: "d1",
      name: "Phone",
      publicKey: "k",
      credentialHash: "h",
      pairedAt: new Date().toISOString(),
    });
    const broken: SecretCodec = {
      seal: codec.seal,
      open: () => {
        throw new Error("keychain reset");
      },
    };
    const reloaded = new MobileAccessStore(path, broken, random);
    await reloaded.load();
    expect(reloaded.devices()).toEqual([]);
    expect((await reloaded.keyPair()).publicKey).not.toEqual(key.publicKey);
  });

  it("treats a damaged file as phone access off", async () => {
    const path = join(directory, "mobile.json");
    await writeFile(path, "{not json");
    const store = new MobileAccessStore(path, codec, random);
    await store.load();
    expect(store.enabled).toBe(false);
  });

  it("adds, touches, and removes phones", async () => {
    const store = new MobileAccessStore(join(directory, "mobile.json"), codec, random);
    await store.load();
    const device = {
      deviceId: "d1",
      name: "Phone",
      publicKey: "k",
      credentialHash: "h",
      pairedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.addDevice(device);
    await store.touchDevice("d1", "2026-01-02T00:00:00.000Z");
    expect(store.device("d1")?.lastSeenAt).toBe("2026-01-02T00:00:00.000Z");
    expect(await store.removeDevice("d1")).toBe(true);
    expect(await store.removeDevice("d1")).toBe(false);
  });
});

describe("PairingWindow", () => {
  it("opens one code at a time, expires it, and uses it once", () => {
    let now = 1_000;
    const window = new PairingWindow(random, () => now);
    const first = window.open();
    const second = window.open();
    expect(window.secretFor(first.pairingId)).toBeUndefined();
    expect(window.secretFor(second.pairingId)).toEqual(second.secret);
    expect(window.consume(second.pairingId)).toBe(true);
    expect(window.consume(second.pairingId)).toBe(false);

    const third = window.open();
    now += PAIRING_TTL_MS;
    expect(window.secretFor(third.pairingId)).toBeUndefined();
    expect(window.current()).toBeUndefined();
  });

  it("withdraws a code after five wrong proofs", () => {
    const window = new PairingWindow(random);
    const pending = window.open();
    for (let attempt = 0; attempt < 4; attempt += 1) window.recordFailure(pending.pairingId);
    expect(window.current()).toBeDefined();
    window.recordFailure(pending.pairingId);
    expect(window.current()).toBeUndefined();
  });
});

describe("AttemptLimiter", () => {
  it("allows a burst up to the limit, then refuses until the window passes", () => {
    let now = 0;
    const limiter = new AttemptLimiter(3, 1_000, () => now);
    expect([1, 2, 3, 4].map(() => limiter.allow("10.0.0.5"))).toEqual([true, true, true, false]);
    expect(limiter.allow("10.0.0.6")).toBe(true);
    now += 1_001;
    expect(limiter.allow("10.0.0.5")).toBe(true);
  });
});

describe("lanAddresses", () => {
  it("lists private LAN addresses first and leaves out loopback, link-local, and IPv6", () => {
    const entry = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({
      address,
      family,
      internal,
      netmask: "255.255.255.0",
      mac: "00:00:00:00:00:00",
      cidr: null,
    });
    const addresses = lanAddresses({
      lo: [entry("127.0.0.1", "IPv4", true)],
      docker0: [entry("172.17.0.1")],
      en0: [entry("fe80::1", "IPv6"), entry("192.168.1.20"), entry("169.254.3.3")],
      eth1: [entry("100.80.1.2")],
    } as never);
    expect(addresses).toEqual(["192.168.1.20", "100.80.1.2", "172.17.0.1"]);
  });
});
