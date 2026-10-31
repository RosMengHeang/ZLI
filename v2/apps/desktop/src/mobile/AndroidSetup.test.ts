import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AndroidEnvironment,
  AndroidSetup,
  avdCreateArgs,
  LicenseNotAcceptedError,
  parseSdkmanagerProgress,
  SdkmanagerLicenseResponder,
  sdkmanagerInstallArgs,
} from "./AndroidSetup.js";
import { ChecksumMismatchError, downloadVerified, type FetchLike } from "./download.js";
import { type FakeProcess, FakeProcessRunner } from "./FakeProcessRunner.js";
import { nodeMobileFileSystem } from "./host.js";

const fixtures = join(import.meta.dirname, "fixtures");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zli-android-setup-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeFetch(routes: Record<string, string | Buffer>, log: string[] = []): FetchLike {
  return async (url) => {
    log.push(url);
    const body = routes[url];
    if (body === undefined)
      return new Response("missing", { status: 404 }) as unknown as Awaited<ReturnType<FetchLike>>;
    return new Response(typeof body === "string" ? body : new Uint8Array(body)) as unknown as Awaited<
      ReturnType<FetchLike>
    >;
  };
}

async function manifests(): Promise<Record<string, string>> {
  return {
    "https://dl.google.com/android/repository/repository2-1.xml": await readFile(
      join(fixtures, "repository2-1.xml"),
      "utf8",
    ),
    "https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml": await readFile(
      join(fixtures, "sys-img2-1.xml"),
      "utf8",
    ),
  };
}

/** An SDK with the command-line tools and Java 17, missing everything the emulator needs. */
async function sdkWithTools(): Promise<{ sdk: string; env: NodeJS.ProcessEnv }> {
  const sdk = join(root, "sdk");
  await mkdir(join(sdk, "cmdline-tools", "latest", "bin"), { recursive: true });
  await writeFile(join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"), "");
  await writeFile(join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"), "");
  await mkdir(join(root, "jdk", "bin"), { recursive: true });
  await writeFile(join(root, "jdk", "bin", "java"), "");
  return { sdk, env: { ANDROID_HOME: sdk, JAVA_HOME: join(root, "jdk"), PATH: "" } };
}

function environment(env: NodeJS.ProcessEnv, runner: FakeProcessRunner) {
  return new AndroidEnvironment({
    os: "linux",
    arch: "x64",
    env,
    home: join(root, "home"),
    mobileDir: join(root, "zli"),
    fs: nodeMobileFileSystem,
    runner,
  });
}

const javaVersion = (_command: string, args: readonly string[]) =>
  args[0] === "-version" ? { stderr: 'openjdk version "17.0.12" 2024-07-16' } : undefined;

describe("Android setup license gating", () => {
  it("refuses to install anything until every license in the plan is accepted", async () => {
    const { env } = await sdkWithTools();
    const runner = new FakeProcessRunner(javaVersion);
    const fetched: string[] = [];
    const setup = new AndroidSetup({
      environment: environment(env, runner),
      fetch: fakeFetch(await manifests(), fetched),
    });
    const plan = await setup.plan();
    expect(plan.licenses.map((license) => license.id)).toEqual(["android-sdk-license"]);
    expect(plan.steps.map((step) => step.id)).toEqual([
      "platform-tools",
      "emulator",
      "system-images;android-35;google_apis;x86_64",
      "avd",
    ]);
    await expect(setup.run([])).rejects.toBeInstanceOf(LicenseNotAcceptedError);
    expect(runner.spawned).toEqual([]);
    expect(fetched.every((url) => url.endsWith(".xml"))).toBe(true);
  });

  it("answers sdkmanager's prompts only for accepted licenses, then creates the AVD", async () => {
    const { sdk, env } = await sdkWithTools();
    const runner = new FakeProcessRunner(javaVersion, (process: FakeProcess) => {
      process.onWrite = (self, data) => {
        if (data !== "y\n") return self.exit(1);
        self.emit("[=======                 ] 50% Downloading x86_64-35_r09.zip... \r");
        self.exit(0);
      };
      queueMicrotask(() =>
        process.emit("License android-sdk-license:\n---------\nTerms and Conditions\n---------\nAccept? (y/N): "),
      );
    });
    const progress: string[] = [];
    const setup = new AndroidSetup({
      environment: environment(env, runner),
      fetch: fakeFetch(await manifests()),
      onProgress: (event) => progress.push(`${event.state}:${event.percent ?? ""}`),
    });
    await setup.plan();
    await setup.run(["android-sdk-license"]);

    const sdkmanager = runner.spawned[0];
    expect(sdkmanager?.args).toEqual(
      sdkmanagerInstallArgs(sdk, ["platform-tools", "emulator", "system-images;android-35;google_apis;x86_64"]),
    );
    expect(sdkmanager?.written).toEqual(["y\n"]);
    const avdmanager = runner.calls.find((call) => call.command.endsWith("avdmanager"));
    expect(avdmanager?.args).toEqual(
      avdCreateArgs("ZLI_Pixel_API_35", "system-images;android-35;google_apis;x86_64", "pixel_7"),
    );
    expect(avdmanager?.options).toMatchObject({ input: "no\n" });
    expect((avdmanager?.options as { env?: NodeJS.ProcessEnv } | undefined)?.env?.JAVA_HOME).toBe(join(root, "jdk"));
    expect(progress).toContain("running:50");
    expect(progress.at(-1)).toBe("done:");
  });

  it("declines a license sdkmanager asks about that the person never saw", async () => {
    const { env } = await sdkWithTools();
    const runner = new FakeProcessRunner(javaVersion, (process: FakeProcess) => {
      process.onWrite = (self) => self.exit(1);
      queueMicrotask(() => process.emit("License android-sdk-preview-license:\n---\nPreview\n---\nAccept? (y/N): "));
    });
    const setup = new AndroidSetup({ environment: environment(env, runner), fetch: fakeFetch(await manifests()) });
    await setup.plan();
    const failure = await setup.run(["android-sdk-license"]).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(LicenseNotAcceptedError);
    expect((failure as LicenseNotAcceptedError).licenseIds).toEqual(["android-sdk-preview-license"]);
    expect(runner.spawned[0]?.written).toEqual(["n\n"]);
    expect(setup.progress.state).toBe("failed");
  });

  it("stops before extracting when the command-line tools fail their checksum", async () => {
    const env = { PATH: "", JAVA_HOME: join(root, "jdk") };
    await mkdir(join(root, "jdk", "bin"), { recursive: true });
    await writeFile(join(root, "jdk", "bin", "java"), "");
    const runner = new FakeProcessRunner(javaVersion);
    const extracted: string[] = [];
    const setup = new AndroidSetup({
      environment: environment(env, runner),
      fetch: fakeFetch({
        ...(await manifests()),
        "https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip": "not the real zip",
      }),
      extractZip: async (archive) => {
        extracted.push(archive);
      },
    });
    const plan = await setup.plan();
    expect(plan.steps[0]?.id).toBe("cmdline-tools;latest");
    await expect(setup.run(["android-sdk-license"])).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(extracted).toEqual([]);
    expect(runner.spawned).toEqual([]);
    expect(await readdir(join(root, "zli", "downloads"))).toEqual([]);
  });
});

describe("verified downloads", () => {
  it("keeps a file whose checksum matches and deletes one that does not", async () => {
    const url = "https://example.com/file.bin";
    const fetch = fakeFetch({ [url]: "hello" });
    const good = join(root, "good.bin");
    await downloadVerified({
      url,
      destination: good,
      algorithm: "sha256",
      checksum: "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824",
      fetch,
    });
    expect(await readFile(good, "utf8")).toBe("hello");

    const bad = join(root, "bad.bin");
    const failure = await downloadVerified({
      url,
      destination: bad,
      algorithm: "sha1",
      checksum: "0".repeat(40),
      fetch,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ChecksumMismatchError);
    expect((failure as ChecksumMismatchError).actual).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect((await readdir(root)).sort()).toEqual(["good.bin"]);
  });

  it("refuses plain HTTP", async () => {
    await expect(
      downloadVerified({
        url: "http://example.com/x",
        destination: join(root, "x"),
        algorithm: "sha1",
        checksum: "",
        fetch: fakeFetch({}),
      }),
    ).rejects.toThrow(/plain HTTP/u);
  });
});

describe("sdkmanager output", () => {
  it("matches each prompt to the license printed before it", () => {
    const responder = new SdkmanagerLicenseResponder(new Set(["android-sdk-license"]));
    expect(responder.feed("License android-sdk-license:\n---\ntext")).toBeUndefined();
    expect(responder.feed("\n---\nAccept? (y/N): ")).toEqual({ licenseId: "android-sdk-license", accept: true });
    expect(responder.feed("License android-sdk-arm-dbt-license:\n---\nAccept? (y/N): ")).toEqual({
      licenseId: "android-sdk-arm-dbt-license",
      accept: false,
    });
  });

  it("reads progress percentages", () => {
    expect(parseSdkmanagerProgress("[=====      ] 42% Unzipping... system.img\r")).toEqual({
      percent: 42,
      message: "Unzipping... system.img",
    });
    expect(parseSdkmanagerProgress("Warning: nothing")).toBeUndefined();
  });
});
