import { randomBytes } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";

import { MobileAccessStatus, type RuntimeProjection } from "@zli-v2/contracts";
import { encodePairingCode, fromBase64Url, toBase64Url } from "@zli-v2/remote-protocol";
import { type BrowserWindow, ipcMain, safeStorage } from "electron";

import { lanAddresses } from "./lanAddresses.js";
import { MobileAccessStore, type SecretCodec } from "./MobileAccessStore.js";
import { DEFAULT_MOBILE_PORT, MobileGateway, type UpstreamTarget } from "./MobileGateway.js";
import { PairingWindow } from "./PairingWindow.js";

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
  projection: () => Pick<RuntimeProjection, "projects" | "worktrees"> | undefined;
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
    let pairingStatus: MobileAccessStatus["pairing"];
    if (pending && state === "listening" && port && hosts.length > 0) {
      pairingStatus = {
        code: encodePairingCode({
          v: 1,
          name: desktopName(),
          hosts,
          port,
          key: toBase64Url((await store.keyPair()).publicKey),
          pairingId: pending.pairingId,
          secret: toBase64Url(pending.secret),
          expiresAt: pending.expiresAt,
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
      devices: store.devices().map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        pairedAt: device.pairedAt,
        ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
        connected: connected.has(device.deviceId),
      })),
    });
  };

  const publish = () => {
    void status()
      .then((value) => {
        if (!window.isDestroyed()) window.webContents.send("zli:mobile:status", value);
      })
      .catch(() => undefined);
  };

  const gateway = new MobileGateway({
    store,
    pairing,
    random,
    upstream: options.upstream,
    projection: options.projection,
    desktopName,
    hosts: reachableHosts,
    onChange: publish,
    log: (message, detail) => options.log?.("info", message, detail),
  });

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
    publish();
  };

  const stop = async () => {
    pairing.close();
    if (expiryTimer) clearTimeout(expiryTimer);
    await gateway.stop();
    state = "off";
    port = undefined;
    errorMessage = undefined;
    publish();
  };

  if (store.enabled) await start();

  ipcMain.handle("zli:mobile:get-status", () => status());
  ipcMain.handle("zli:mobile:set-enabled", async (_event, input: unknown) => {
    const enabled = (input as { enabled?: unknown } | null)?.enabled === true;
    await store.setEnabled(enabled);
    if (enabled) await start();
    else await stop();
    return status();
  });
  ipcMain.handle("zli:mobile:start-pairing", async () => {
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
  ipcMain.handle("zli:mobile:cancel-pairing", () => {
    pairing.close();
    if (expiryTimer) clearTimeout(expiryTimer);
    return status();
  });
  ipcMain.handle("zli:mobile:revoke", async (_event, input: unknown) => {
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
