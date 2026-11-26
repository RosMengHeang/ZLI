import { randomBytes } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";

import { MobileAccessStatus, type RuntimeProjection } from "@zli-v2/contracts";
import { fromBase64Url, toBase64Url } from "@zli-v2/remote-protocol";
import { type BrowserWindow, ipcMain, safeStorage } from "electron";
import { WebSocket } from "ws";

import { lanAddresses } from "./lanAddresses.js";
import { MobileAccessStore, type SecretCodec } from "./MobileAccessStore.js";
import { DEFAULT_MOBILE_PORT, MobileGateway, type UpstreamTarget } from "./MobileGateway.js";
import { PairingApprovals } from "./PairingApprovals.js";
import { PairingWindow } from "./PairingWindow.js";
import { PhonePush, type PushFetch } from "./PhonePush.js";
import { RelayHost } from "./RelayHost.js";
import { desktopPairingCode, RelayLink, relayUrlFrom } from "./relayAccess.js";

const random = (length: number) => new Uint8Array(randomBytes(length));

/** Seals the desktop key with the OS keychain where Electron can reach one. */
const keychainCodec: SecretCodec = {
  seal(secret) {
    if (safeStorage.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(toBase64Url(secret)).toString("base64")}`;
    }
    return `plain:${toBase64Url(secret)}`;
  },
  open(sealed) {
    if (sealed.startsWith("safe:")) {
      return fromBase64Url(safeStorage.decryptString(Buffer.from(sealed.slice(5), "base64")));
    }
    if (sealed.startsWith("plain:")) return fromBase64Url(sealed.slice(6));
    throw new Error("Unknown key format.");
  },
};

function desktopName(): string {
  return (
    hostname()
      .replace(/\.local$/iu, "")
      .slice(0, 80) || "ZLI desktop"
  );
}

function reachableHosts(): string[] {
  return lanAddresses(networkInterfaces());
}

/**
 * Wires Settings to the phone gateway. Nothing listens on the network until the person turns
 * phone access on, and turning it off closes every phone connection.
 */
export async function registerMobileAccess(options: {
  window: BrowserWindow;
  settingsPath: string;
  upstream: () => Promise<UpstreamTarget>;
  projection: () => RuntimeProjection | undefined;
  subscribe: (listener: (projection: RuntimeProjection) => void) => () => void;
  /** Reaches Expo's push service, for phones that are not connected. */
  fetch: PushFetch;
  log?: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}): Promise<{ stop(): Promise<void> }> {
  const { window } = options;
  const store = new MobileAccessStore(options.settingsPath, keychainCodec, random);
  await store.load();
  const pairing = new PairingWindow(random);
  let state: MobileAccessStatus["state"] = "off";
  let errorMessage: string | undefined;
  let port: number | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;

  const status = async (): Promise<MobileAccessStatus> => {
    const connected = gateway.connectedDeviceIds();
    const hosts = state === "listening" ? reachableHosts() : [];
    const pending = pairing.current();
    const request = approvals.current();
    let pairingStatus: MobileAccessStatus["pairing"];
    if (pending && state === "listening" && port && hosts.length > 0) {
      const route = relay.route();
      pairingStatus = {
        code: desktopPairingCode({
          name: desktopName(),
          hosts,
          port,
          key: toBase64Url((await store.keyPair()).publicKey),
          pending,
          ...(route ? { relay: route } : {}),
        }),
        expiresAt: new Date(pending.expiresAt).toISOString(),
      };
    }
    return MobileAccessStatus.parse({
      enabled: store.enabled,
      state,
      ...(errorMessage ? { errorMessage } : {}),
      hosts,
      ...(port ? { port } : {}),
      ...(pairingStatus ? { pairing: pairingStatus } : {}),
      ...(request
        ? {
            pairingRequest: {
              id: request.id,
              deviceName: request.deviceName,
              expiresAt: new Date(request.expiresAt).toISOString(),
            },
          }
        : {}),
      devices: store.devices().map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        pairedAt: device.pairedAt,
        ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
        connected: connected.has(device.deviceId),
        push: device.push !== undefined,
      })),
      relay: {
        available: relay.available,
        enabled: store.relay.enabled,
        state: relay.state,
        remoteTerminalInput: store.relay.remoteTerminalInput,
        ...(relay.errorMessage ? { errorMessage: relay.errorMessage } : {}),
      },
    });
  };

  const publish = () => {
    void status()
      .then((value) => {
        if (!window.isDestroyed()) window.webContents.send("zli:remote:status", value);
      })
      .catch(() => undefined);
  };

  // The person is already in Settings, looking at the code, so the request shows there and needs no notification.
  const approvals = new PairingApprovals({ random, onChange: () => publish() });

  const gateway = new MobileGateway({
    store,
    pairing,
    approvePairing: (request) => approvals.ask(request),
    random,
    upstream: options.upstream,
    projection: options.projection,
    desktopName,
    hosts: reachableHosts,
    onChange: publish,
    log: (message, detail) => options.log?.("info", message, detail),
  });

  // The relay URL is read from ZLI_RELAY_URL when the desktop starts. Without one, Connect from anywhere stays unavailable.
  const relay = new RelayLink({
    url: relayUrlFrom(process.env.ZLI_RELAY_URL),
    store,
    gateway,
    createHost: ({ route, secret, onState }) =>
      new RelayHost({
        route,
        secret,
        gateway,
        createSocket: (url, socketOptions) => new WebSocket(url, socketOptions),
        onState,
      }),
    onChange: publish,
  });

  const push = new PhonePush({
    store,
    attentive: () => gateway.attentiveDeviceIds(),
    fetch: options.fetch,
    onChange: publish,
    log: (message, detail) => options.log?.("warn", message, detail),
  });
  const initial = options.projection();
  if (initial) push.update(initial);
  options.subscribe((projection) => push.update(projection));

  const start = async () => {
    if (gateway.listening) return;
    state = "starting";
    errorMessage = undefined;
    publish();
    try {
      port = await gateway.start({ port: store.port ?? DEFAULT_MOBILE_PORT });
      await store.setPort(port);
      state = "listening";
    } catch (error) {
      state = "failed";
      port = undefined;
      errorMessage = `Phone access could not start: ${error instanceof Error ? error.message : String(error)}`;
      options.log?.("error", "phone gateway failed to start", { error: String(error) });
    }
    // Outside the try: a relay that fails reports its own error and leaves the gateway as it is.
    relay.sync();
    publish();
  };

  const stop = async () => {
    pairing.close();
    approvals.deny();
    if (expiryTimer) clearTimeout(expiryTimer);
    relay.stop();
    await gateway.stop();
    state = "off";
    port = undefined;
    errorMessage = undefined;
    publish();
  };

  if (store.enabled) await start();

  ipcMain.handle("zli:remote:get-status", () => status());
  ipcMain.handle("zli:remote:set-enabled", async (_event, input: unknown) => {
    const enabled = (input as { enabled?: unknown } | null)?.enabled === true;
    await store.setEnabled(enabled);
    if (enabled) await start();
    else await stop();
    return status();
  });
  ipcMain.handle("zli:remote:set-relay-enabled", async (_event, input: unknown) => {
    const enabled = (input as { enabled?: unknown } | null)?.enabled === true;
    if (enabled && !relay.available) throw new Error("This build has no relay set up.");
    await store.setRelayEnabled(enabled);
    relay.sync();
    return status();
  });
  ipcMain.handle("zli:remote:set-remote-terminal-input", async (_event, input: unknown) => {
    const enabled = (input as { enabled?: unknown } | null)?.enabled === true;
    if (enabled && !store.relay.enabled) throw new Error("Turn on Connect from anywhere first.");
    await store.setRemoteTerminalInput(enabled);
    return status();
  });
  ipcMain.handle("zli:remote:retry-relay", () => {
    relay.retry();
    return status();
  });
  ipcMain.handle("zli:remote:start-pairing", async () => {
    if (!store.enabled) throw new Error("Turn on phone access first.");
    if (!gateway.listening) await start();
    if (state !== "listening") return status();
    if (reachableHosts().length === 0) {
      errorMessage = "This computer has no network address a phone can reach. Connect to Wi-Fi or Ethernet.";
      return status();
    }
    errorMessage = undefined;
    const pending = pairing.open();
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(publish, pending.expiresAt - Date.now() + 50);
    // The code holds the desktop key, so the key exists before the first code is shown.
    await store.keyPair();
    return status();
  });
  ipcMain.handle("zli:remote:cancel-pairing", () => {
    pairing.close();
    approvals.deny();
    if (expiryTimer) clearTimeout(expiryTimer);
    return status();
  });
  ipcMain.handle("zli:remote:respond-to-pairing", (_event, input: unknown) => {
    const { id, allow } = (input ?? {}) as { id?: unknown; allow?: unknown };
    if (typeof id !== "string" || id.length === 0 || id.length > 100) throw new Error("Choose a pairing request.");
    // An answer for a request that already ended is ignored; the status shows what is waiting now.
    approvals.respond(id, allow === true);
    return status();
  });
  ipcMain.handle("zli:remote:revoke", async (_event, input: unknown) => {
    const deviceId = (input as { deviceId?: unknown } | null)?.deviceId;
    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 100) {
      throw new Error("Choose a phone to remove.");
    }
    await store.removeDevice(deviceId);
    gateway.disconnect(deviceId);
    return status();
  });

  return { stop };
}
