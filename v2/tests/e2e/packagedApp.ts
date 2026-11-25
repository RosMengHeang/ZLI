import { access, cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

const V2_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** What electron-builder packed. The installers that ship are built from here. */
export const RELEASE_ROOT = join(V2_ROOT, "apps/desktop/release");
/** The copy the integration tests run. Nothing in it ships. */
export const TEST_RELEASE_ROOT = join(V2_ROOT, "apps/desktop/release-e2e");

/** One electron-builder layout: the folder that holds the app, and its executable, both under a release folder. */
type Layout = { folder: string; executable: string };

function layouts(platform: NodeJS.Platform): Layout[] {
  if (platform === "win32") return [{ folder: "win-unpacked", executable: "win-unpacked/ZLI.exe" }];
  if (platform === "darwin") {
    return ["mac", "mac-arm64", "mac-x64"].map((dir) => ({
      folder: `${dir}/ZLI.app`,
      executable: `${dir}/ZLI.app/Contents/MacOS/ZLI`,
    }));
  }
  return [
    { folder: "linux-unpacked", executable: "linux-unpacked/ZLI" },
    { folder: "linux-unpacked", executable: "linux-unpacked/zli" },
  ];
}

async function findLayout(root: string): Promise<Layout | undefined> {
  for (const layout of layouts(process.platform)) {
    try {
      await access(join(root, layout.executable));
      return layout;
    } catch {
      // Try the next electron-builder layout for this platform.
    }
  }
  return undefined;
}

/**
 * Copies the packaged app for the integration tests and lets the copy take --inspect, which Playwright attaches
 * through. The packaged app ignores --inspect so that no other program can start it in a debugger; only this copy,
 * which never ships, turns that back on. Every other fuse stays as packed.
 */
export async function prepareTestApp(): Promise<void> {
  const layout = await findLayout(RELEASE_ROOT);
  if (!layout) throw new Error(`Packaged ZLI executable was not found under ${RELEASE_ROOT}.`);
  await rm(TEST_RELEASE_ROOT, { recursive: true, force: true });
  const target = join(TEST_RELEASE_ROOT, layout.folder);
  await cp(join(RELEASE_ROOT, layout.folder), target, { recursive: true, verbatimSymlinks: true });
  await flipFuses(process.platform === "darwin" ? target : join(TEST_RELEASE_ROOT, layout.executable), {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: process.platform === "darwin",
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
  });
}

/** The test copy's executable, made by prepareTestApp in the Playwright global setup. */
export async function testAppExecutable(): Promise<string> {
  const layout = await findLayout(TEST_RELEASE_ROOT);
  if (!layout) {
    throw new Error(`The test copy of ZLI was not found under ${TEST_RELEASE_ROOT}. The global setup makes it.`);
  }
  return join(TEST_RELEASE_ROOT, layout.executable);
}
