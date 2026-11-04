import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertInstallPaths,
  bundleParentWritable,
  isTranslocatedMacApp,
  macAppBundle,
  readUnsignedMacInstallError,
  startUnsignedMacInstall,
  UNSIGNED_MAC_UPDATE_SCRIPT,
} from "./unsignedMacInstall.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("mac app bundle", () => {
  // macAppBundle splits on the platform separator. These fixtures are macOS paths, so Windows never splits them.
  it.skipIf(process.platform === "win32")("finds the bundle that contains the executable", () => {
    expect(macAppBundle("/Applications/ZLI.app/Contents/MacOS/ZLI")).toBe("/Applications/ZLI.app");
    expect(macAppBundle("/usr/local/bin/electron")).toBeUndefined();
    expect(isTranslocatedMacApp("/private/var/folders/ab/AppTranslocation/XYZ/d/ZLI.app")).toBe(true);
    expect(isTranslocatedMacApp("/Applications/ZLI.app")).toBe(false);
  });

  it("rejects paths the helper would have to interpret", () => {
    expect(() => assertInstallPaths("ZLI.zip", "/Applications/ZLI.app")).toThrow(/zip file/u);
    expect(() => assertInstallPaths("/tmp/ZLI.zip\n", "/Applications/ZLI.app")).toThrow(/zip file/u);
    expect(() => assertInstallPaths("/tmp/ZLI.zip", "/Applications/Other.app")).toThrow(/installed app/u);
  });

  it("can write a real folder and not a missing one", () => {
    expect(bundleParentWritable("/no/such/zli-parent/ZLI.app")).toBe(false);
    expect(bundleParentWritable(join(tmpdir(), "ZLI.app"))).toBe(true);
  });
});

describe("unsigned macOS install error", () => {
  it("returns the first line once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-update-error-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const errorPath = join(directory, "unsigned-mac-update-error.txt");
    writeFileSync(errorPath, "Could not open the downloaded update.\nmore");
    expect(await readUnsignedMacInstallError(errorPath)).toBe("Could not open the downloaded update.");
    expect(await readUnsignedMacInstallError(errorPath)).toBeUndefined();
  });
});

describe("unsigned macOS swap", () => {
  it("keeps paths in the environment", () => {
    expect(UNSIGNED_MAC_UPDATE_SCRIPT).toContain("ditto -x -k " + '"$' + "{ZLI_UPDATE_ZIP}" + '"');
    expect(UNSIGNED_MAC_UPDATE_SCRIPT).toContain(
      '"' + "$" + "{ZLI_UPDATE_OPEN:-open}" + '" "' + "$" + "{ZLI_UPDATE_BUNDLE}" + '"',
    );
    expect(UNSIGNED_MAC_UPDATE_SCRIPT).toContain("ZLI_UPDATE_SETTLE_SECONDS:-0.5");
    expect(UNSIGNED_MAC_UPDATE_SCRIPT).toContain("kill -0");
    expect(UNSIGNED_MAC_UPDATE_SCRIPT).not.toContain("/Applications");
  });

  // The installer only accepts absolute macOS paths (/…/ZLI.app). Windows temp paths are not those.
  it.skipIf(process.platform === "win32")(
    "replaces ZLI.app after the process exits and opens the new copy",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "zli-update-swap-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const bundle = join(directory, "ZLI.app");
      const marker = join(bundle, "Contents", "MacOS", "marker");
      mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
      writeFileSync(marker, "old");
      const zip = await zipApp(directory, "new");
      const opened = join(directory, "opened");
      const bin = join(directory, "bin");
      writeStubs(bin, opened);

      const errorPath = join(directory, "update-error.txt");
      startUnsignedMacInstall({
        zipPath: zip,
        bundlePath: bundle,
        pid: await reapedPid(),
        logPath: join(directory, "update.log"),
        errorPath,
        pathEnv: `${bin}:/usr/bin:/bin`,
        settleSeconds: 0,
        skipWait: true,
        openCommand: join(bin, "open"),
      });

      const openedText = await readWhenReady(opened, errorPath);
      expect(openedText).toBe(`${bundle}\n`);
      expect(await readFile(marker, "utf8")).toBe("new");
      expect(await readUnsignedMacInstallError(join(directory, "update-error.txt"))).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")("leaves the installed app in place when the zip has no ZLI.app", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-update-bad-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const bundle = join(directory, "ZLI.app");
    const marker = join(bundle, "Contents", "marker");
    mkdirSync(join(bundle, "Contents"), { recursive: true });
    writeFileSync(marker, "old");
    const source = join(directory, "source");
    mkdirSync(join(source, "Other.app"), { recursive: true });
    writeFileSync(join(source, "Other.app", "marker"), "new");
    const zip = join(directory, "update.zip");
    zipDirectory(source, zip);
    const bin = join(directory, "bin");
    writeStubs(bin, join(directory, "opened"));

    startUnsignedMacInstall({
      zipPath: zip,
      bundlePath: bundle,
      pid: await reapedPid(),
      logPath: join(directory, "update.log"),
      errorPath: join(directory, "update-error.txt"),
      pathEnv: `${bin}:/usr/bin:/bin`,
      settleSeconds: 0,
      skipWait: true,
      openCommand: join(bin, "open"),
    });

    expect(await readWhenReady(join(directory, "update-error.txt"))).toContain("did not contain ZLI.app");
    expect(await readFile(marker, "utf8")).toBe("old");
  });
});

/** A pid that has already been reaped, so the helper's kill -0 loop exits on the first check. */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("sleeper did not start");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  return pid;
}

async function zipApp(directory: string, contents: string): Promise<string> {
  const source = join(directory, "source");
  mkdirSync(join(source, "ZLI.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(source, "ZLI.app", "Contents", "MacOS", "marker"), contents);
  const zip = join(directory, "update.zip");
  zipDirectory(source, zip);
  return zip;
}

function zipDirectory(source: string, zip: string): void {
  execFileSync("python3", [
    "-c",
    `import os, sys, zipfile
root, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, "w") as archive:
    for dirpath, _, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            archive.write(full, os.path.relpath(full, root))
`,
    source,
    zip,
  ]);
}

function writeStubs(bin: string, opened: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "ditto"),
    `#!/usr/bin/env python3
import sys, zipfile
if sys.argv[1:3] != ["-x", "-k"]:
    raise SystemExit("unexpected ditto args: " + " ".join(sys.argv[1:]))
zipfile.ZipFile(sys.argv[3]).extractall(sys.argv[4])
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "xattr"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$1" > ${JSON.stringify(opened)}\n`, { mode: 0o755 });
  chmodSync(join(bin, "ditto"), 0o755);
  chmodSync(join(bin, "xattr"), 0o755);
  chmodSync(join(bin, "open"), 0o755);
}

async function readWhenReady(path: string, errorPath?: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    if (errorPath) {
      try {
        const failure = (await readFile(errorPath, "utf8")).trim();
        if (failure) throw new Error(failure);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}
