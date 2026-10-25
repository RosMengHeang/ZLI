import type { CreateWebSocket, RandomBytes, WebSocketLike } from "@zli-v2/remote-protocol";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";

import { parseStoredPairing, type StoredPairing, serializePairing } from "./lib/pairingRecord.js";

export const random: RandomBytes = (length) => Crypto.getRandomBytes(length);

export const newId = (): string => Crypto.randomUUID();

export const createSocket: CreateWebSocket = (url) => new WebSocket(url) as unknown as WebSocketLike;

const PAIRING_KEY = "zli.remote.pairing.v1";
/** Kept out of backups and other devices: a restored copy would be a second phone with the same key. */
const storeOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadPairing(): Promise<StoredPairing | undefined> {
  return parseStoredPairing(await SecureStore.getItemAsync(PAIRING_KEY, storeOptions));
}

export async function savePairing(pairing: StoredPairing): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, serializePairing(pairing), storeOptions);
}

export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRING_KEY, storeOptions);
}

export function defaultDeviceName(): string {
  const name = Device.deviceName?.trim() || Device.modelName?.trim() || "Phone";
  return name.slice(0, 60);
}
