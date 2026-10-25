import { readFile } from "node:fs/promises";

import { generateKeyPair, type KeyPair, keyPairFromSecret, type RandomBytes } from "@zli-v2/remote-protocol";
import { z } from "zod";

import { writeJsonFile } from "../storage/writeJsonFile.js";

/** Seals the desktop's secret key at rest. Electron's safeStorage when the OS keychain is available. */
export interface SecretCodec {
  seal(secret: Uint8Array): string;
  /** Throws when the sealed text cannot be opened, for example after the OS keychain was reset. */
  open(sealed: string): Uint8Array;
}

const StoredDevice = z.object({
  deviceId: z.string().min(1).max(100),
  name: z.string().min(1).max(60),
  /** The phone's long-lived X25519 public key, which every resumed handshake must match. */
  publicKey: z.string().min(1).max(100),
  /** SHA-256 of the device credential, base64url. */
  credentialHash: z.string().min(1).max(100),
  pairedAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
});
export type StoredDevice = z.infer<typeof StoredDevice>;

const StoredSettings = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65_535).optional(),
  desktopKey: z.string().min(1).max(4_000).optional(),
  devices: z.array(StoredDevice).max(100).default([]),
});
type StoredSettings = z.infer<typeof StoredSettings>;

const MAX_DEVICES = 20;

/**
 * Phone access settings: whether it is on, the port, the desktop's key pair, and paired phones.
 * The file holds a secret key, so it is written readable by the owner only.
 */
export class MobileAccessStore {
  #settings: StoredSettings = { enabled: false, devices: [] };
  #keyPair: KeyPair | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec,
    private readonly random: RandomBytes,
  ) {}

  async load(): Promise<void> {
    try {
      this.#settings = StoredSettings.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      // A missing or unreadable file means phone access is off with nothing paired.
      this.#settings = { enabled: false, devices: [] };
    }
    this.#keyPair = undefined;
    if (this.#settings.desktopKey) {
      try {
        this.#keyPair = keyPairFromSecret(this.codec.open(this.#settings.desktopKey));
      } catch {
        // Phones paired with the lost key can never finish a handshake again, so they go too.
        this.#settings = { ...this.#settings, desktopKey: undefined, devices: [] };
      }
    }
  }

  get enabled(): boolean {
    return this.#settings.enabled;
  }

  get port(): number | undefined {
    return this.#settings.port;
  }

  devices(): StoredDevice[] {
    return this.#settings.devices.map((device) => ({ ...device }));
  }

  device(deviceId: string): StoredDevice | undefined {
    const device = this.#settings.devices.find((candidate) => candidate.deviceId === deviceId);
    return device ? { ...device } : undefined;
  }

  /** The desktop's long-lived key pair, created and saved on first use. */
  async keyPair(): Promise<KeyPair> {
    if (this.#keyPair) return this.#keyPair;
    const pair = generateKeyPair(this.random);
    this.#keyPair = pair;
    await this.#save({ ...this.#settings, desktopKey: this.codec.seal(pair.secretKey) });
    return pair;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#save({ ...this.#settings, enabled });
  }

  async setPort(port: number): Promise<void> {
    if (this.#settings.port === port) return;
    await this.#save({ ...this.#settings, port });
  }

  /** Adds a phone. The oldest phone is dropped past the limit, so the file stays small. */
  async addDevice(device: StoredDevice): Promise<void> {
    const devices = [...this.#settings.devices.filter((entry) => entry.deviceId !== device.deviceId), device];
    await this.#save({ ...this.#settings, devices: devices.slice(-MAX_DEVICES) });
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    const devices = this.#settings.devices.filter((entry) => entry.deviceId !== deviceId);
    if (devices.length === this.#settings.devices.length) return false;
    await this.#save({ ...this.#settings, devices });
    return true;
  }

  async touchDevice(deviceId: string, seenAt: string): Promise<void> {
    if (!this.#settings.devices.some((entry) => entry.deviceId === deviceId)) return;
    const devices = this.#settings.devices.map((entry) =>
      entry.deviceId === deviceId ? { ...entry, lastSeenAt: seenAt } : entry,
    );
    await this.#save({ ...this.#settings, devices });
  }

  async #save(next: StoredSettings): Promise<void> {
    this.#settings = next;
    const snapshot = structuredClone(next);
    // Quick changes share one temporary file, so writes go one at a time.
    const write = this.#writing.then(() => writeJsonFile(this.path, snapshot, { mode: 0o600 }));
    this.#writing = write.catch(() => undefined);
    await write;
  }
}
