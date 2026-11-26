import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodePairingCode,
  fromBase64Url,
  webCryptoRandomBytes as random,
  roomIdFromSecret,
  toBase64Url,
} from "@zli-v2/remote-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttemptLimiter } from "./AttemptLimiter.js";
import { lanAddresses } from "./lanAddresses.js";
import { MobileAccessStore, type SecretCodec } from "./MobileAccessStore.js";
import { PAIRING_TTL_MS, PairingWindow } from "./PairingWindow.js";
import type { RelayState } from "./RelayHost.js";
import { desktopPairingCode, RelayLink, relayUrlFrom } from "./relayAccess.js";

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

  it("keeps a phone's push token across loads and clears it on request", async () => {
    const path = join(directory, "mobile.json");
    const store = new MobileAccessStore(path, codec, random);
    await store.load();
    await store.addDevice({
      deviceId: "d1",
      name: "Phone",
      publicKey: "k",
      credentialHash: "h",
      pairedAt: "2026-01-01T00:00:00.000Z",
    });
    const push = { token: "ExponentPushToken[abc]", platform: "ios" } as const;
    expect(await store.setPush("d1", push)).toBe(true);
    expect(await store.setPush("d1", push)).toBe(false);
    expect(await store.setPush("missing", push)).toBe(false);

    const reloaded = new MobileAccessStore(path, codec, random);
    await reloaded.load();
    expect(reloaded.device("d1")?.push).toEqual(push);
    expect(await reloaded.setPush("d1", undefined)).toBe(true);
    expect(reloaded.device("d1")).not.toHaveProperty("push");
    expect(await readFile(path, "utf8")).not.toContain("ExponentPushToken");
  });
});

describe("MobileAccessStore relay settings", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zli-mobile-relay-"));
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it("starts with the relay and remote terminal input off and no relay secret", async () => {
    const store = new MobileAccessStore(join(directory, "mobile.json"), codec, random);
    await store.load();
    expect(store.relay).toEqual({ enabled: false, remoteTerminalInput: false });
    expect(store.relaySecret()).toBeUndefined();
  });

  it("keeps relay settings across loads and stores the relay secret only sealed", async () => {
    const path = join(directory, "mobile.json");
    const store = new MobileAccessStore(path, codec, random);
    await store.load();
    await store.setRelayEnabled(true);
    await store.setRemoteTerminalInput(true);
    const secret = store.relaySecret();
    expect(secret).toHaveLength(32);

    const reloaded = new MobileAccessStore(path, codec, random);
    await reloaded.load();
    expect(reloaded.relay).toEqual({ enabled: true, remoteTerminalInput: true });
    expect(reloaded.relaySecret()).toEqual(secret);
    const file = await readFile(path, "utf8");
    expect(file).toContain(`sealed:${toBase64Url(secret ?? new Uint8Array())}`);
    expect(JSON.parse(file).relaySecret).toBe(`sealed:${toBase64Url(secret ?? new Uint8Array())}`);
  });

  it("keeps the same secret while the relay stays on, and deletes it when the relay is turned off", async () => {
    const path = join(directory, "mobile.json");
    const store = new MobileAccessStore(path, codec, random);
    await store.load();
    await store.setRelayEnabled(true);
    const first = store.relaySecret();
    await store.setRelayEnabled(true);
    expect(store.relaySecret()).toEqual(first);
    await store.setRemoteTerminalInput(true);

    await store.setRelayEnabled(false);
    expect(store.relaySecret()).toBeUndefined();
    expect(store.relay).toEqual({ enabled: false, remoteTerminalInput: false });
    expect(await readFile(path, "utf8")).not.toContain("relaySecret");

    await store.setRelayEnabled(true);
    expect(store.relaySecret()).not.toEqual(first);
  });

  it("turns the relay off when its sealed secret can no longer be opened", async () => {
    const path = join(directory, "mobile.json");
    const store = new MobileAccessStore(path, codec, random);
    await store.load();
    await store.keyPair();
    await store.setRelayEnabled(true);
    let opened = 0;
    const desktopKeyOnly: SecretCodec = {
      seal: codec.seal,
      open: (text) => {
        opened += 1;
        // The desktop key opens first; the relay secret after it fails.
        if (opened > 1) throw new Error("keychain reset");
        return codec.open(text);
      },
    };
    const reloaded = new MobileAccessStore(path, desktopKeyOnly, random);
    await reloaded.load();
    expect(reloaded.relay.enabled).toBe(false);
    expect(reloaded.relaySecret()).toBeUndefined();
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

describe("relayUrlFrom", () => {
  it("takes a wss:// relay URL and refuses anything else", () => {
    expect(relayUrlFrom("wss://relay.example.test")).toBe("wss://relay.example.test");
    expect(relayUrlFrom(undefined)).toBeUndefined();
    expect(relayUrlFrom("")).toBeUndefined();
    expect(relayUrlFrom("ws://relay.example.test")).toBeUndefined();
    expect(relayUrlFrom("https://relay.example.test")).toBeUndefined();
    expect(relayUrlFrom("wss://relay.example.test/?token=x")).toBeUndefined();
    expect(relayUrlFrom("not a url")).toBeUndefined();
  });
});

describe("desktopPairingCode", () => {
  const base = {
    name: "Desk",
    hosts: ["192.168.1.20"],
    port: 47_321,
    key: toBase64Url(random(32)),
    pending: { pairingId: toBase64Url(random(16)), secret: random(32), expiresAt: Date.now() + 60_000 },
  };

  it("carries no relay route while the relay is off", () => {
    expect(decodePairingCode(desktopPairingCode(base)).relay).toBeUndefined();
  });

  it("carries the relay URL and the room derived from the relay secret while it is on", () => {
    const secret = random(32);
    const code = decodePairingCode(
      desktopPairingCode({ ...base, relay: { url: "wss://relay.example.test", room: roomIdFromSecret(secret) } }),
    );
    expect(code.relay).toEqual({ url: "wss://relay.example.test", room: roomIdFromSecret(secret) });
    expect(code.hosts).toEqual(["192.168.1.20"]);
  });
});

describe("RelayLink", () => {
  let directory: string;
  let store: MobileAccessStore;
  let listening: boolean;
  let hosts: Array<{ route: { url: string; room: string }; secret: Uint8Array; running: boolean; starts: number }>;
  let onStates: Array<(state: RelayState) => void>;
  let changes: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zli-relay-link-"));
    store = new MobileAccessStore(join(directory, "mobile.json"), codec, random);
    await store.load();
    listening = true;
    hosts = [];
    onStates = [];
    changes = 0;
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  function link(url: string | null = "wss://relay.example.test") {
    return new RelayLink({
      url: url ?? undefined,
      store,
      gateway: {
        get listening() {
          return listening;
        },
      },
      createHost: ({ route, secret, onState }) => {
        const host = { route, secret, running: false, starts: 0 };
        hosts.push(host);
        onStates.push(onState);
        return {
          start: () => {
            host.running = true;
            host.starts += 1;
            onState("connecting");
          },
          stop: () => {
            host.running = false;
            onState("off");
          },
        };
      },
      onChange: () => {
        changes += 1;
      },
    });
  }

  it("runs the relay host only while the relay is on, the gateway listens, and a relay URL is set", async () => {
    const relay = link();
    relay.sync();
    expect(hosts).toHaveLength(0);
    expect(relay.state).toBe("off");

    await store.setRelayEnabled(true);
    listening = false;
    relay.sync();
    expect(hosts).toHaveLength(0);

    listening = true;
    relay.sync();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.running).toBe(true);
    expect(hosts[0]?.route).toEqual({
      url: "wss://relay.example.test",
      room: roomIdFromSecret(store.relaySecret() ?? new Uint8Array()),
    });
    expect(relay.state).toBe("connecting");
    relay.sync();
    expect(hosts).toHaveLength(1);

    listening = false;
    relay.sync();
    expect(hosts[0]?.running).toBe(false);
    expect(relay.state).toBe("off");

    listening = true;
    relay.sync();
    expect(hosts).toHaveLength(2);
    await store.setRelayEnabled(false);
    relay.sync();
    expect(hosts[1]?.running).toBe(false);
    expect(relay.route()).toBeUndefined();
  });

  it("never runs without a relay URL, and says the relay is not available", async () => {
    await store.setRelayEnabled(true);
    const relay = link(null);
    relay.sync();
    expect(relay.available).toBe(false);
    expect(relay.route()).toBeUndefined();
    expect(hosts).toHaveLength(0);
  });

  it("follows the host's state and ignores a host it already stopped", async () => {
    await store.setRelayEnabled(true);
    const relay = link();
    relay.sync();
    onStates[0]?.("online");
    expect(relay.state).toBe("online");
    const before = changes;
    relay.stop();
    onStates[0]?.("offline");
    expect(relay.state).toBe("off");
    expect(changes).toBeGreaterThan(before);
  });

  it("dials a new room when the secret changes", async () => {
    await store.setRelayEnabled(true);
    const relay = link();
    relay.sync();
    await store.setRelayEnabled(false);
    await store.setRelayEnabled(true);
    relay.sync();
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.running).toBe(false);
    expect(hosts[1]?.route.room).not.toBe(hosts[0]?.route.room);
  });

  it("retries a replaced room with the same secret", async () => {
    await store.setRelayEnabled(true);
    const relay = link();
    relay.sync();
    onStates[0]?.("replaced");
    expect(relay.state).toBe("replaced");
    relay.retry();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.starts).toBe(2);
    expect(hosts[0]?.running).toBe(true);
    expect(relay.state).toBe("connecting");
  });
});
