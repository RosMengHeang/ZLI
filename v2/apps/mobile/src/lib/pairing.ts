import {
  type CreateWebSocket,
  credentialBytes,
  DeviceName,
  decodePairingCode,
  failureMessage,
  fromBase64Url,
  generateKeyPair,
  keyPairFromSecret,
  openRemoteSession,
  PairingCodeError,
  type RandomBytes,
  RemoteConnectError,
  type RemoteFailure,
  remoteUrl,
  requestUnpair,
  toBase64Url,
} from "@zli-v2/remote-protocol";

import { hostsToTry, type StoredPairing, withReady } from "./pairingRecord.js";

export class PairError extends Error {
  override name = "PairError";
}

export type PairDeps = {
  random: RandomBytes;
  createSocket: CreateWebSocket;
  now: () => number;
  openSession?: typeof openRemoteSession;
};

/** Failures where another listed address might still answer. */
const tryNextHost = new Set<RemoteFailure>(["network", "timeout", "unavailable"]);

/** The desktop name inside a pairing code, or why the code cannot be used. */
export function previewPairingCode(text: string, now: number): { desktopName: string } | { error: string } {
  try {
    const code = decodePairingCode(text);
    if (code.expiresAt <= now) return { error: "This pairing code expired. Make a new one on the desktop." };
    return { desktopName: code.name };
  } catch (error) {
    return { error: error instanceof PairingCodeError ? error.message : "This is not a ZLI pairing code." };
  }
}

/** Pairs with the desktop named in a pairing code. Rejects with PairError, whose message is shown as is. */
export async function pairWithDesktop(codeText: string, deviceName: string, deps: PairDeps): Promise<StoredPairing> {
  const preview = previewPairingCode(codeText, deps.now());
  if ("error" in preview) throw new PairError(preview.error);
  const code = decodePairingCode(codeText);
  const name = DeviceName.safeParse(deviceName);
  if (!name.success) throw new PairError("Give this phone a name of up to 60 characters.");

  const phone = generateKeyPair(deps.random);
  const open = deps.openSession ?? openRemoteSession;
  let lastFailure: RemoteFailure = "network";
  for (const host of code.hosts) {
    try {
      const session = await open({
        url: remoteUrl(host, code.port),
        serverPublicKey: fromBase64Url(code.key),
        clientStatic: phone,
        target: {
          mode: "pair",
          pairingId: code.pairingId,
          pairingSecret: fromBase64Url(code.secret),
          deviceName: name.data,
        },
        random: deps.random,
        createSocket: deps.createSocket,
        timeoutMs: 8_000,
      });
      session.transport.close();
      if (!session.paired) throw new PairError(failureMessage("protocol"));
      const pairing: StoredPairing = {
        v: 1,
        desktopName: code.name,
        hosts: code.hosts,
        port: code.port,
        desktopKey: code.key,
        deviceId: session.paired.deviceId,
        credential: session.paired.credential,
        phoneSecret: toBase64Url(phone.secretKey),
        deviceName: name.data,
        pairedAt: new Date(deps.now()).toISOString(),
      };
      return withReady(pairing, session.ready, host);
    } catch (error) {
      if (!(error instanceof RemoteConnectError)) throw error;
      if (!tryNextHost.has(error.failure)) throw new PairError(error.message);
      lastFailure = error.failure;
    }
  }
  if (lastFailure === "network" || lastFailure === "timeout") {
    throw new PairError(
      `Could not reach ${code.name}. Check that the phone is on the same Wi-Fi as the desktop and that phone access is still on.`,
    );
  }
  throw new PairError(failureMessage(lastFailure));
}

/** Asks the desktop to forget this phone. Resolves false when no address answered. */
export async function unpairFromDesktop(
  pairing: StoredPairing,
  deps: Pick<PairDeps, "random" | "createSocket"> & { unpair?: typeof requestUnpair },
): Promise<boolean> {
  const unpair = deps.unpair ?? requestUnpair;
  for (const host of hostsToTry(pairing)) {
    try {
      await unpair({
        url: remoteUrl(host, pairing.port),
        serverPublicKey: fromBase64Url(pairing.desktopKey),
        clientStatic: keyPairFromSecret(fromBase64Url(pairing.phoneSecret)),
        target: { mode: "resume", deviceId: pairing.deviceId, credential: credentialBytes(pairing.credential) },
        random: deps.random,
        createSocket: deps.createSocket,
        timeoutMs: 5_000,
      });
      return true;
    } catch (error) {
      if (!(error instanceof RemoteConnectError)) throw error;
      // A desktop that already forgot the phone needs nothing more.
      if (error.failure === "not-paired") return true;
    }
  }
  return false;
}
