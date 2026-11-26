import { z } from "zod";

/** A phone paired with this desktop. The credential itself never leaves the desktop's settings file. */
export const PairedPhone = z.object({
  deviceId: z.string().min(1).max(100),
  name: z.string().min(1).max(60),
  pairedAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  connected: z.boolean(),
  /** The phone gave the desktop a push token, so alerts reach it while ZLI Remote is closed. */
  push: z.boolean().default(false),
});
export type PairedPhone = z.infer<typeof PairedPhone>;

export const MobilePairing = z.object({
  /** The text the QR code encodes, which a person can also paste on the phone. */
  code: z.string().min(1).max(2_000),
  expiresAt: z.string().datetime({ offset: true }),
});
export type MobilePairing = z.infer<typeof MobilePairing>;

/** A pairing that came through the relay, held until the person at the desktop allows it. */
export const MobilePairingRequest = z.object({
  id: z.string().min(1).max(100),
  deviceName: z.string().min(1).max(60),
  expiresAt: z.string().datetime({ offset: true }),
});
export type MobilePairingRequest = z.infer<typeof MobilePairingRequest>;

/**
 * The desktop's link to ZLI's relay. `replaced` means another PC claimed the same room; the desktop waits for the
 * person before it tries again, so two PCs do not take the room from each other forever.
 */
export const RelayState = z.enum(["off", "connecting", "online", "offline", "budget-exhausted", "replaced"]);
export type RelayState = z.infer<typeof RelayState>;

/** Connect from anywhere. `available` is false when this build has no relay set up. */
export const RelayAccessStatus = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  state: RelayState,
  remoteTerminalInput: z.boolean(),
  /** Why the relay could not start. Phone access on the LAN keeps working. */
  errorMessage: z.string().min(1).max(500).optional(),
});
export type RelayAccessStatus = z.infer<typeof RelayAccessStatus>;

/** What Settings shows for phone access. Off by default; nothing listens on the network until it is on. */
export const MobileAccessStatus = z.object({
  enabled: z.boolean(),
  state: z.enum(["off", "starting", "listening", "failed"]),
  errorMessage: z.string().min(1).max(500).optional(),
  hosts: z.array(z.string().min(1).max(253)).max(8),
  port: z.number().int().min(0).max(65_535).optional(),
  pairing: MobilePairing.optional(),
  pairingRequest: MobilePairingRequest.optional(),
  devices: z.array(PairedPhone).max(100),
  relay: RelayAccessStatus.default({ available: false, enabled: false, state: "off", remoteTerminalInput: false }),
});
export type MobileAccessStatus = z.infer<typeof MobileAccessStatus>;
