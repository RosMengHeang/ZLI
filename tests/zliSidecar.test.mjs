import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

test("ZLI sidecar names follow Tauri target-triple conventions", async () => {
  const { sidecarFileName } = await import("../scripts/prepare-zli-sidecar.mjs");

  assert.equal(sidecarFileName("x86_64-pc-windows-msvc"), "zli-x86_64-pc-windows-msvc.exe");
  assert.equal(sidecarFileName("aarch64-apple-darwin"), "zli-aarch64-apple-darwin");
});

test("ZLI sidecar preparation resolves Cargo output with and without an explicit target", async () => {
  const { builtBinaryPath } = await import("../scripts/prepare-zli-sidecar.mjs");
  const targetDir = path.resolve("build-target");

  assert.equal(
    builtBinaryPath(targetDir, "x86_64-pc-windows-msvc", false),
    path.join(targetDir, "release", "zli.exe"),
  );
  assert.equal(
    builtBinaryPath(targetDir, "x86_64-pc-windows-msvc", true),
    path.join(targetDir, "x86_64-pc-windows-msvc", "release", "zli.exe"),
  );
});

test("Tauri release builds receive sidecar configuration without affecting dev commands", async () => {
  const { tauriArguments } = await import("../scripts/run-tauri.mjs");

  assert.deepEqual(tauriArguments(["dev"]), ["dev"]);
  const build = tauriArguments(["build", "--bundles", "nsis"]);
  assert.deepEqual(build.slice(0, 3), ["build", "--bundles", "nsis"]);
  assert.equal(build.at(-2), "--config");
  assert.deepEqual(JSON.parse(build.at(-1)), { bundle: { externalBin: ["binaries/zli", "binaries/zli-browser-use"] } });
});

test("browser-use sidecars resolve to the paired release binary", async () => {
  const { browserUseBuiltBinaryPath, browserUseSidecarFileName } = await import("../scripts/prepare-zli-sidecar.mjs");

  assert.equal(browserUseSidecarFileName("x86_64-pc-windows-msvc"), "zli-browser-use-x86_64-pc-windows-msvc.exe");
  assert.equal(
    browserUseBuiltBinaryPath(path.resolve("build-target"), "x86_64-pc-windows-msvc", true),
    path.join(path.resolve("build-target"), "x86_64-pc-windows-msvc", "release", "zli-browser-use.exe"),
  );
});

test("installSidecarBinary refuses to clobber a locked destination and leaves .new", async () => {
  const { installSidecarBinary } = await import("../scripts/prepare-zli-sidecar.mjs");
  const copied = [];
  const error = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

  assert.throws(
    () =>
      installSidecarBinary("built.exe", "binaries/zli.exe", {
        exists: () => true,
        copyFile: (source, destination) => {
          copied.push([source, destination]);
          if (destination === "binaries/zli.exe") throw error;
        },
        remove: () => {
          throw new Error("should not remove staging after lock failure");
        },
      }),
    /Refusing to overwrite in-use sidecar/,
  );

  assert.deepEqual(copied, [
    ["built.exe", "binaries/zli.exe.new"],
    ["binaries/zli.exe.new", "binaries/zli.exe"],
  ]);
});

test("installSidecarBinary copies when the destination is missing", async () => {
  const { installSidecarBinary } = await import("../scripts/prepare-zli-sidecar.mjs");
  const copied = [];
  const result = installSidecarBinary("built.exe", "binaries/zli.exe", {
    exists: () => false,
    copyFile: (source, destination) => {
      copied.push([source, destination]);
    },
  });
  assert.deepEqual(copied, [["built.exe", "binaries/zli.exe"]]);
  assert.equal(result.destination, "binaries/zli.exe");
});
