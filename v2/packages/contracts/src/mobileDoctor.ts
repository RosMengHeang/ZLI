import { z } from "zod";

import { MobileControlDeviceInput } from "./mobile.js";
import { MobileProjectFactsCore, PROPOSAL_FILES } from "./mobileDev.js";

const Version = z.string().max(60);

/** How the app runs during development. */
export const MobileClientKind = z.enum(["expo-go", "dev-build", "bare", "unknown"]);
export type MobileClientKind = z.infer<typeof MobileClientKind>;

export const MobilePackageManager = z.enum(["npm", "pnpm", "yarn", "bun"]);
export type MobilePackageManager = z.infer<typeof MobilePackageManager>;

/** One Expo check that runs the project's own code. */
export const MobileDoctorDeepStep = z.object({
  ok: z.boolean(),
  state: z.enum(["passed", "failed", "not-installed", "timed-out"]),
  /** The last lines of output when the step failed, or why it did not run. */
  detail: z.string().max(2_000).optional(),
});
export type MobileDoctorDeepStep = z.infer<typeof MobileDoctorDeepStep>;

export const MobileDoctorDeep = z.object({
  ranAt: z.string().datetime({ offset: true }),
  expoConfig: MobileDoctorDeepStep.extend({ sdkVersion: Version.optional() }).optional(),
  expoInstallCheck: MobileDoctorDeepStep.extend({ packages: z.array(z.string().max(214)).max(100) }).optional(),
  expoDoctor: MobileDoctorDeepStep.extend({ failures: z.array(z.string().max(300)).max(50) }).optional(),
});
export type MobileDoctorDeep = z.infer<typeof MobileDoctorDeep>;

/** What the doctor knows about a worktree's app. Every field past the core is optional, so older readers still parse it. */
export const MobileProjectFacts = MobileProjectFactsCore.extend({
  client: z.object({ kind: MobileClientKind, reason: z.string().max(300) }).optional(),
  newArch: z
    .object({
      enabled: z.boolean().optional(),
      source: z.string().max(200).optional(),
      /** Files that set newArchEnabled to false. */
      disabledIn: z.array(z.string().max(200)).max(5).optional(),
    })
    .optional(),
  appIds: z
    .object({
      android: z.string().max(200).optional(),
      ios: z.string().max(200).optional(),
      scheme: z.string().max(100).optional(),
    })
    .optional(),
  android: z
    .object({
      gradle: Version.optional(),
      agp: Version.optional(),
      kotlin: Version.optional(),
      builtInKotlinOptOut: z.boolean().optional(),
      newDslOptOut: z.boolean().optional(),
    })
    .optional(),
  ios: z
    .object({
      podfile: z.boolean(),
      podsDrift: z.boolean().optional(),
      deploymentTarget: Version.optional(),
      /** Whether the Xcode project names a development team. The team itself is not read. */
      developmentTeam: z.boolean().optional(),
    })
    .optional(),
  signing: z
    .object({
      android: z.enum(["debug-only", "release-config", "eas", "unknown"]),
      ios: z.union([z.object({ identities: z.number().int().min(0) }), z.literal("not-checked")]),
    })
    .optional(),
  /** Tools on this computer: a version, "not found", or "not checked" where the tool cannot run here. */
  host: z.record(z.string().max(40), z.string().max(60)).optional(),
  deep: MobileDoctorDeep.optional(),
  packageManager: MobilePackageManager.optional(),
  /** Whether expo-dev-client is a dependency. */
  devClient: z.boolean().optional(),
  /** Like fingerprint, over the versions the project declares only, so it is the same on every computer. */
  projectFingerprint: z.string().max(40).optional(),
  /** ZLI's block in AGENTS.md or CLAUDE.md: missing, current, or written from older facts. */
  notes: z.object({ file: z.enum(PROPOSAL_FILES), state: z.enum(["missing", "current", "outdated"]) }).optional(),
  /** Files that exist but could not be parsed; their facts are unknown. */
  unreadable: z.array(z.string().max(200)).max(20).optional(),
});
export type MobileProjectFacts = z.infer<typeof MobileProjectFacts>;

export const MobileDoctorInput = z.object({ worktreeId: z.string().min(1).max(200) });
export type MobileDoctorInput = z.infer<typeof MobileDoctorInput>;

export const MobileDoctorCheckInput = MobileDoctorInput.extend({ refresh: z.boolean().optional() });
export type MobileDoctorCheckInput = z.infer<typeof MobileDoctorCheckInput>;

export const MobileDoctorProposeFixInput = MobileDoctorInput.extend({ findingId: z.string().min(1).max(80) });
export type MobileDoctorProposeFixInput = z.infer<typeof MobileDoctorProposeFixInput>;

/** The exact command lines Run Expo checks runs, shown before anything runs, and the folder they run in. */
export const MobileDoctorDeepPlan = z.object({
  folder: z.string().max(300),
  commands: z.array(z.string().max(300)).max(5),
});
export type MobileDoctorDeepPlan = z.infer<typeof MobileDoctorDeepPlan>;

/** Prepare notes: either a file-block proposal now waits for the person, or the block is already current. */
export const MobileAgentsBlockResult = z.discriminatedUnion("upToDate", [
  z.object({ upToDate: z.literal(true), file: z.enum(PROPOSAL_FILES) }),
  z.object({
    upToDate: z.literal(false),
    file: z.enum(PROPOSAL_FILES),
    content: z.string().max(8_000),
    proposalId: z.string().uuid(),
  }),
]);
export type MobileAgentsBlockResult = z.infer<typeof MobileAgentsBlockResult>;

/** mobile_doctor from an agent. Never runs the Expo checks; it returns their last results. */
export const MobileControlDoctorInput = MobileControlDeviceInput.extend({ refresh: z.boolean().optional() });
export type MobileControlDoctorInput = z.infer<typeof MobileControlDoctorInput>;
