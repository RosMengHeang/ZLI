import { z } from "zod";

const Version = z.string().min(1).max(64);
/** Release notes as GitHub returns them: Markdown, or HTML from the releases feed. */
const ReleaseNotes = z.string().max(50_000);

/** Where the desktop app's self-update stands. Only `available` and `ready` need the person. */
export const UpdateState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({ status: z.literal("checking") }),
  z.object({
    status: z.literal("available"),
    version: Version,
    notes: ReleaseNotes.optional(),
    releaseUrl: z.string().url(),
    /** False where the app cannot replace itself, such as unsigned macOS builds; the release page has the download. */
    canAutoInstall: z.boolean(),
  }),
  z.object({ status: z.literal("downloading"), version: Version, percent: z.number().min(0).max(100) }),
  z.object({ status: z.literal("ready"), version: Version, notes: ReleaseNotes.optional() }),
  z.object({ status: z.literal("error"), message: z.string().min(1).max(1_000) }),
]);
export type UpdateState = z.infer<typeof UpdateState>;

export const UpdateChannel = z.enum(["stable"]);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

export const UpdateStatus = z.object({
  state: UpdateState,
  currentVersion: Version,
  lastCheckedAt: z.string().datetime({ offset: true }).optional(),
  autoInstall: z.boolean(),
  channel: UpdateChannel,
  /** Set when this launch never checks, such as development and test runs. */
  disabledReason: z.string().min(1).max(200).optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** The release the app was just updated to, shown once after the update. */
export const WhatsNew = z.object({
  version: Version,
  notes: ReleaseNotes.optional(),
  releaseUrl: z.string().url(),
});
export type WhatsNew = z.infer<typeof WhatsNew>;

export const UpdateAutoInstallInput = z.object({ autoInstall: z.boolean() });
