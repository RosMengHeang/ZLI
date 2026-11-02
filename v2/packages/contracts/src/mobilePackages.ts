import { z } from "zod";

import { MobileControlDeviceInput } from "./mobile.js";
import { MobileProposalAction } from "./mobileDev.js";

/** An npm package name, optionally with @version, such as expo-camera, @shopify/flash-list, or react-native-mmkv@3.1.0. */
// A leading "-" would turn the name into an install option such as --force, and < or > pass name validation only
// to be refused as unsafe arguments later, so both are rejected here.
export const NPM_PACKAGE_NAME = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*(@[A-Za-z0-9._^~=-]{1,60})?$/u;
export const NpmPackageName = z.string().min(1).max(214).regex(NPM_PACKAGE_NAME, "Not an npm package name.");

export const MobilePackageVerdict = z.object({
  /** As asked, including any @version. */
  name: z.string().max(214),
  verdict: z.enum(["ok", "warn", "block", "unchecked"]),
  reasons: z.array(z.string().max(300)).max(10),
  newArchitecture: z.enum(["supported", "unsupported", "untested", "new-arch-only"]).optional(),
  expoGo: z.boolean().optional(),
  configPlugin: z.boolean().optional(),
  unmaintained: z.boolean().optional(),
  latest: z.string().max(60).optional(),
});
export type MobilePackageVerdict = z.infer<typeof MobilePackageVerdict>;

export const MobilePackageCheck = z.object({
  verdicts: z.array(MobilePackageVerdict).max(20),
  /** The command that installs every package that was not blocked. Absent when none remain or there is no package.json. */
  install: MobileProposalAction.optional(),
  /** The install command as the person reads it. */
  command: z.string().max(2_000).optional(),
});
export type MobilePackageCheck = z.infer<typeof MobilePackageCheck>;

// React Native Directory's answers. Unknown fields are dropped, so the API can add fields without breaking ZLI.
const DirectoryNewArch = z.union([z.string().max(40), z.boolean()]).optional();

/** GET /api/libraries/check?packages=a,b: one entry per package the directory lists. */
export const ReactNativeDirectoryCheck = z.record(
  z.string(),
  z.object({ newArchitecture: DirectoryNewArch, unmaintained: z.boolean().optional() }).nullable(),
);
export type ReactNativeDirectoryCheck = z.infer<typeof ReactNativeDirectoryCheck>;

/** GET /api/library?name=a: one library's details. */
export const ReactNativeDirectoryLibrary = z.object({
  expoGo: z.boolean().optional(),
  newArchitecture: DirectoryNewArch,
  unmaintained: z.boolean().optional(),
  github: z
    .object({ configPlugin: z.union([z.boolean(), z.string()]).optional(), isArchived: z.boolean().optional() })
    .optional(),
  npm: z.object({ latestRelease: z.string().max(60).optional() }).optional(),
});
export type ReactNativeDirectoryLibrary = z.infer<typeof ReactNativeDirectoryLibrary>;

const PackageList = z.array(NpmPackageName).min(1).max(20);

/** mobile_check_package from an agent. */
export const MobileCheckPackageInput = MobileControlDeviceInput.extend({ packages: PackageList });
export type MobileCheckPackageInput = z.infer<typeof MobileCheckPackageInput>;

/** The Packages group: check names, or propose installing them, in a worktree. */
export const MobilePackagesInput = z.object({ worktreeId: z.string().min(1).max(200), packages: PackageList });
export type MobilePackagesInput = z.infer<typeof MobilePackagesInput>;
