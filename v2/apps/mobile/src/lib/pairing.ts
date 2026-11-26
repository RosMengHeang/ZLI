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
  PAIRING_CODE_PREFIX,
  PairingCodeError,
  type RandomBytes,
  RemoteConnectError,
  remoteUrl,
  requestUnpair,
  toBase64Url,
} from "@zli-v2/remote-protocol";

import { hostsToTry, type StoredPairing, withReady } from "./pairingRecord.js";
import { raceRoutes } from "./routes.js";

export class PairError extends Error {
  override name = "PairError";
}

export type PairDeps = {
  random: RandomBytes;
  createSocket: CreateWebSocket;
  now: () => number;
  openSession?: typeof openRemoteSession;
};

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

/** The privacy line on the pair screen. It names the relay only when the code carries one. */
export function pairingPrivacyNote(text: string, now: number): string {
  let relay: boolean | undefined;
  if ("desktopName" in previewPairingCode(text, now)) relay = decodePairingCode(text).relay !== undefined;
  if (relay === undefined) {
    return "Everything between the phone and the desktop is encrypted with keys that stay on the two devices.";
  }
  return relay
    ? "The phone connects on the same network as the desktop, or through ZLI's relay when it is away. Everything between them is encrypted with keys that stay on the two devices, so the relay can't read it."
    : "The phone and the desktop need to be on the same network. Everything between them is encrypted with keys that stay on the two devices.";
}

/**
 * The pairing code carried by a link that opened the app: the code itself, which is a
 * `zli-remote:` URL, or a link with the code in its `code` parameter, as development builds use.
 */
export function pairingCodeFromLink(url: string): string | undefined {
  const text = url.trim();
  if (text.startsWith(PAIRING_CODE_PREFIX)) return text;
  const match = /[?&]code=([^&#]+)/u.exec(text);
  if (!match?.[1]) return undefined;
  try {
    const code = decodeURIComponent(match[1]).trim();
    return code.startsWith(PAIRING_CODE_PREFIX) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pairs with the desktop named in a pairing code. Rejects with PairError, whose message is shown as is. `onWaiting`
 * fires when a pairing through the relay waits for the person at the desktop to allow it.
 */
export async function pairWithDesktop(
  codeText: string,
  deviceName: string,
  deps: PairDeps,
  events: { onWaiting?: () => void } = {},
): Promise<StoredPairing> {
  const preview = previewPairingCode(codeText, deps.now());
  if ("error" in preview) throw new PairError(preview.error);
  const code = decodePairingCode(codeText);
  const name = DeviceName.safeParse(deviceName);
  if (!name.success) throw new PairError("Give this phone a name of up to 60 characters.");

  const phone = generateKeyPair(deps.random);
  const open = deps.openSession ?? openRemoteSession;
  let won: Awaited<ReturnType<typeof raceRoutes>>;
  try {
    // Sequential: a code works once, so a losing route must never reject it under a winning one.
    won = await raceRoutes({
      lanHosts: code.hosts,
      port: code.port,
      relay: code.relay,
      sequential: true,
      open: (url, signal, route) =>
        open({
          url,
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
          // A relay attempt the desktop holds for approval gets the longer approval timeout from the session itself.
          timeoutMs: 8_000,
          signal,
          ...(route === "relay" && events.onWaiting ? { onWaiting: events.onWaiting } : {}),
        }),
    });
  } catch (error) {
    if (!(error instanceof RemoteConnectError)) throw error;
    if (error.failure === "network" || error.failure === "timeout") {
      throw new PairError(
        code.relay
          ? `Could not reach ${code.name}. Check that it is on and connected to the internet, and that phone access is still on.`
          : `Could not reach ${code.name}. Check that the phone is on the same Wi-Fi as the desktop and that phone access is still on.`,
      );
    }
    throw new PairError(error.message);
  }
  const { session } = won;
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
    ...(code.relay ? { relay: code.relay } : {}),
    pairedAt: new Date(deps.now()).toISOString(),
  };
  return withReady(pairing, session.ready, won.host, won.route);
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
