import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ensureMacPtyHelpersExecutable } from "../../scripts/after-pack.mjs";

describe("macOS node-pty packaging", () => {
  it("marks each packaged architecture's spawn helper executable", async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), "zli-pty-package-"));
    const resources = join(appOutDir, "ZLI.app", "Contents", "Resources", "app.asar.unpacked");
    const helpers = ["darwin-arm64", "darwin-x64"].map((platformArch) =>
      join(resources, "node_modules", "node-pty", "prebuilds", platformArch, "spawn-helper"),
    );
    const chmodFile = vi.fn(async () => undefined);

    try {
      for (const helper of helpers) {
        await mkdir(join(helper, ".."), { recursive: true });
        await writeFile(helper, "test helper");
      }

      await ensureMacPtyHelpersExecutable({ appOutDir, electronPlatformName: "darwin" }, chmodFile);

      expect(chmodFile).toHaveBeenCalledTimes(2);
      expect(chmodFile).toHaveBeenNthCalledWith(1, helpers[0], 0o755);
      expect(chmodFile).toHaveBeenNthCalledWith(2, helpers[1], 0o755);
    } finally {
      await rm(appOutDir, { recursive: true, force: true });
    }
  });
});
