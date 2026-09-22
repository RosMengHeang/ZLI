import { access, chmod } from "node:fs/promises";
import { join } from "node:path";

const macArchitectures = ["darwin-arm64", "darwin-x64"];

export async function ensureMacPtyHelpersExecutable(context, chmodFile = chmod) {
  if (context.electronPlatformName !== "darwin") return;

  const unpackedModules = join(
    context.appOutDir,
    "ZLI.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  const helpers = macArchitectures.map((architecture) => join(unpackedModules, architecture, "spawn-helper"));
  const packagedHelpers = [];

  for (const helper of helpers) {
    try {
      await access(helper);
      packagedHelpers.push(helper);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (packagedHelpers.length === 0) {
    throw new Error("Packaged node-pty macOS spawn-helper was not found in app.asar.unpacked.");
  }

  await Promise.all(packagedHelpers.map((helper) => chmodFile(helper, 0o755)));
}

export default async function afterPack(context) {
  await ensureMacPtyHelpersExecutable(context);
}
