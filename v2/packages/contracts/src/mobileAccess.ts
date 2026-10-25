import { z } from "zod";

/** A phone paired with this desktop. The credential itself never leaves the desktop's settings file. */
export const MobileDevice = z.object({
  deviceId: z.string().min(1).max(100),
  name: z.string().min(1).max(60),
  pairedAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  connected: z.boolean(),
});
export type MobileDevice = z.infer<typeof MobileDevice>;

export const MobilePairing = z.object({
  /** The text the QR code encodes, which a person can also paste on the phone. */
  code: z.string().min(1).max(2_000),
  expiresAt: z.string().datetime({ offset: true }),
});
export type MobilePairing = z.infer<typeof MobilePairing>;

/** What Settings shows for phone access. Off by default; nothing listens on the network until it is on. */
export const MobileAccessStatus = z.object({
  enabled: z.boolean(),
  state: z.enum(["off", "starting", "listening", "failed"]),
  errorMessage: z.string().min(1).max(500).optional(),
  hosts: z.array(z.string().min(1).max(253)).max(8),
  port: z.number().int().min(0).max(65_535).optional(),
  pairing: MobilePairing.optional(),
  devices: z.array(MobileDevice).max(100),
});
export type MobileAccessStatus = z.infer<typeof MobileAccessStatus>;
