import { mkdir, rename, rm } from "node:fs/promises";

import type { MobileAndroidStatus, MobileSetupPlan, MobileSetupProgress } from "@zli-v2/contracts";
import {
  ANDROID_REPOSITORY_URL,
  type AndroidSetupPlanDetails,
  adoptiumReleaseUrl,
  archiveUrl,
  DEFAULT_AVD_DEVICE,
  DEFAULT_AVD_NAME,
  GOOGLE_APIS_SYSTEM_IMAGES_URL,
  parseAdoptiumRelease,
  parseRepository,
  planAndroidSetup,
  systemImagePackage,
} from "./AndroidRepository.js";
import {
  type AccelerationCheck,
  type AndroidSdkLayout,
  type AvdInfo,
  androidStatus,
  avdHome,
  checkAcceleration,
  detectAndroidSdk,
  detectJava,
  type JavaRuntime,
  listAvds,
  listSystemImages,
  MIN_JAVA_MAJOR,
} from "./AndroidSdk.js";
import { downloadVerified, type FetchLike } from "./download.js";
import { type HostArch, type HostOs, type MobileFileSystem, pathFor } from "./host.js";
import { commandName, type ProcessRunner, runChecked } from "./ProcessRunner.js";
import { extractZip } from "./unzip.js";

export type AndroidEnvironmentDeps = {
  readonly os: HostOs;
  readonly arch: HostArch;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  /** ZLI's own folder for mobile downloads: its SDK copy, Java runtime, and scrcpy server live here. */
  readonly mobileDir: string;
  readonly fs: MobileFileSystem;
  readonly runner: ProcessRunner;
};

export type AndroidInspection = {
  readonly layout: AndroidSdkLayout;
  readonly java: JavaRuntime | undefined;
  readonly systemImages: readonly string[];
  readonly avds: readonly AvdInfo[];
  readonly acceleration: AccelerationCheck;
  readonly status: MobileAndroidStatus;
};

export function zliSdkRoot(deps: Pick<AndroidEnvironmentDeps, "os" | "mobileDir">): string {
  return pathFor(deps.os).join(deps.mobileDir, "android-sdk");
}

export function zliJreRoot(deps: Pick<AndroidEnvironmentDeps, "os" | "mobileDir">): string {
  return pathFor(deps.os).join(deps.mobileDir, "jre");
}

/** Environment for SDK tools: the SDK root they act on and the Java they run with. */
export function sdkToolEnv(
  base: NodeJS.ProcessEnv,
  os: HostOs,
  sdkRoot: string,
  java: JavaRuntime | undefined,
): NodeJS.ProcessEnv {
  const path = pathFor(os);
  return {
    ...base,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    ...(java ? { JAVA_HOME: path.dirname(path.dirname(java.path)) } : {}),
  };
}

export class AndroidEnvironment {
  readonly #deps: AndroidEnvironmentDeps;
  readonly #acceleration = new Map<string, AccelerationCheck>();

  constructor(deps: AndroidEnvironmentDeps) {
    this.#deps = deps;
  }

  get deps(): AndroidEnvironmentDeps {
    return this.#deps;
  }

  async inspect(options: { recheckAcceleration?: boolean } = {}): Promise<AndroidInspection> {
    const deps = this.#deps;
    const layout = await detectAndroidSdk({
      os: deps.os,
      env: deps.env,
      home: deps.home,
      zliSdkRoot: zliSdkRoot(deps),
      fs: deps.fs,
    });
    const [java, systemImages, avds] = await Promise.all([
      detectJava({ os: deps.os, env: deps.env, zliJreRoot: zliJreRoot(deps), fs: deps.fs, runner: deps.runner }),
      listSystemImages(layout.root, deps.os, deps.fs),
      listAvds(avdHome(deps.os, deps.home, deps.env), deps.os, deps.fs),
    ]);
    let acceleration = layout.emulator ? this.#acceleration.get(layout.emulator) : undefined;
    if (!acceleration || options.recheckAcceleration) {
      acceleration = await checkAcceleration(deps.runner, layout.emulator);
      if (layout.emulator) this.#acceleration.set(layout.emulator, acceleration);
    }
    return {
      layout,
      java,
      systemImages,
      avds,
      acceleration,
      status: androidStatus({ layout, java, systemImages, avds, acceleration }),
    };
  }
}

export class LicenseNotAcceptedError extends Error {
  constructor(readonly licenseIds: readonly string[]) {
    super(`Setup needs these licenses accepted first: ${licenseIds.join(", ")}.`);
    this.name = "LicenseNotAcceptedError";
  }
}

export type AndroidSetupDeps = {
  readonly environment: AndroidEnvironment;
  readonly fetch: FetchLike;
  readonly extractZip?: (archive: string, destination: string) => Promise<unknown>;
  readonly onProgress?: (progress: MobileSetupProgress) => void;
};

type PreparedPlan = { readonly public: MobileSetupPlan; readonly details: AndroidSetupPlanDetails };

/**
 * Installs what the emulator needs. Nothing is downloaded until the person has seen and accepted every
 * license the plan lists, and sdkmanager's own license prompts are answered yes only for those licenses.
 */
export class AndroidSetup {
  readonly #deps: AndroidSetupDeps;
  #plan: PreparedPlan | undefined;
  #abort: AbortController | undefined;
  #progress: MobileSetupProgress = { state: "idle", message: "" };

  constructor(deps: AndroidSetupDeps) {
    this.#deps = deps;
  }

  get progress(): MobileSetupProgress {
    return this.#progress;
  }

  get running(): boolean {
    return this.#abort !== undefined;
  }

  async plan(): Promise<MobileSetupPlan> {
    const inspection = await this.#deps.environment.inspect();
    const { os, arch } = this.#deps.environment.deps;
    const { layout, java, systemImages, avds } = inspection;
    const plannedImage = systemImagePackage(arch);
    const needs = {
      cmdlineTools: !layout.sdkmanager || !layout.avdmanager,
      java: !java || java.major < MIN_JAVA_MAJOR,
      platformTools: !layout.adb?.startsWith(layout.root),
      emulator: !layout.emulator,
      systemImage: !systemImages.includes(plannedImage) && avds.length === 0,
      avd: avds.length === 0,
    };
    const anySdkPackage = needs.platformTools || needs.emulator || needs.systemImage || needs.avd;
    const effectiveNeeds = {
      ...needs,
      cmdlineTools: needs.cmdlineTools && anySdkPackage,
      java: needs.java && anySdkPackage,
    };
    const [repositoryXml, systemImagesXml, javaRelease] = await Promise.all([
      this.#fetchText(ANDROID_REPOSITORY_URL),
      effectiveNeeds.systemImage ? this.#fetchText(GOOGLE_APIS_SYSTEM_IMAGES_URL) : Promise.resolve(""),
      effectiveNeeds.java ? this.#fetchJson(adoptiumReleaseUrl(os, arch)) : Promise.resolve(undefined),
    ]);
    const details = planAndroidSetup({
      os,
      arch,
      needs: effectiveNeeds,
      repository: parseRepository(repositoryXml),
      systemImages: parseRepository(systemImagesXml),
      ...(javaRelease === undefined ? {} : { java: parseAdoptiumRelease(javaRelease) }),
    });
    const plan: MobileSetupPlan = {
      sdkRoot: layout.root,
      steps: details.steps,
      licenses: details.licenses,
      systemImage: details.systemImage,
      avdName: DEFAULT_AVD_NAME,
    };
    this.#plan = { public: plan, details };
    return plan;
  }

  cancel(): void {
    this.#abort?.abort();
  }

  async run(acceptedLicenses: readonly string[]): Promise<void> {
    if (this.#abort) throw new Error("Android setup is already running.");
    if (!this.#plan) await this.plan();
    const plan = this.#plan;
    if (!plan) throw new Error("Android setup has no plan.");
    const accepted = new Set(acceptedLicenses);
    const refused = plan.public.licenses.map((license) => license.id).filter((id) => !accepted.has(id));
    if (refused.length > 0) throw new LicenseNotAcceptedError(refused);

    const abort = new AbortController();
    this.#abort = abort;
    try {
      await this.#install(plan, accepted, abort.signal);
      this.#report({ state: "done", message: "Android is ready. Boot the virtual device to start." });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#report(
        abort.signal.aborted
          ? { state: "cancelled", message: "Setup was cancelled. Run it again to continue where it stopped." }
          : { state: "failed", ...(this.#progress.stepId ? { stepId: this.#progress.stepId } : {}), message },
      );
      throw cause;
    } finally {
      this.#abort = undefined;
      this.#plan = undefined;
    }
  }

  async #install(plan: PreparedPlan, accepted: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    const environment = this.#deps.environment;
    const deps = environment.deps;
    const path = pathFor(deps.os);
    const downloads = path.join(deps.mobileDir, "downloads");
    const sdkRoot = plan.public.sdkRoot;
    const { details } = plan;

    if (details.java) {
      const java = details.java;
      this.#report({
        state: "running",
        stepId: "java",
        message: "Downloading the Java runtime",
        totalBytes: java.size,
      });
      const archive = await downloadVerified({
        url: java.url,
        destination: path.join(downloads, java.name),
        algorithm: "sha256",
        checksum: java.sha256,
        fetch: this.#deps.fetch,
        signal,
        onProgress: (received, total) => this.#bytes("java", "Downloading the Java runtime", received, total),
      });
      this.#report({ state: "running", stepId: "java", message: "Unpacking the Java runtime" });
      const jreRoot = zliJreRoot(deps);
      await rm(jreRoot, { recursive: true, force: true });
      await mkdir(jreRoot, { recursive: true });
      if (archive.endsWith(".zip")) await (this.#deps.extractZip ?? extractZip)(archive, jreRoot);
      else await runChecked(deps.runner, "tar", ["-xzf", archive, "-C", jreRoot], { timeoutMs: 300_000, signal });
      await rm(archive, { force: true });
    }

    if (details.cmdlineTools) {
      const archive = details.cmdlineTools;
      const label = "Downloading the Android command-line tools";
      this.#report({ state: "running", stepId: "cmdline-tools;latest", message: label, totalBytes: archive.size });
      const file = await downloadVerified({
        url: archiveUrl(archive),
        destination: path.join(downloads, path.basename(archive.url)),
        algorithm: "sha1",
        checksum: archive.sha1,
        fetch: this.#deps.fetch,
        signal,
        onProgress: (received, total) => this.#bytes("cmdline-tools;latest", label, received, total),
      });
      this.#report({ state: "running", stepId: "cmdline-tools;latest", message: "Unpacking the command-line tools" });
      const staging = path.join(sdkRoot, "cmdline-tools", ".zli-staging");
      const latest = path.join(sdkRoot, "cmdline-tools", "latest");
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await (this.#deps.extractZip ?? extractZip)(file, staging);
      await rm(latest, { recursive: true, force: true });
      await rename(path.join(staging, "cmdline-tools"), latest);
      await rm(staging, { recursive: true, force: true });
      await rm(file, { force: true });
    }

    const inspection = await environment.inspect();
    const env = sdkToolEnv(deps.env, deps.os, sdkRoot, inspection.java);
    if (details.sdkPackages.length > 0) {
      if (!inspection.layout.sdkmanager)
        throw new Error("sdkmanager is missing after installing the command-line tools.");
      await this.#sdkmanager(inspection.layout.sdkmanager, sdkRoot, details.sdkPackages, accepted, env, signal);
    }

    if (plan.public.steps.some((step) => step.id === "avd")) {
      const after = await environment.inspect();
      if (!after.layout.avdmanager) throw new Error("avdmanager is missing after installing the command-line tools.");
      this.#report({ state: "running", stepId: "avd", message: `Creating the virtual device ${plan.public.avdName}` });
      await runChecked(
        deps.runner,
        after.layout.avdmanager,
        avdCreateArgs(plan.public.avdName, plan.public.systemImage, DEFAULT_AVD_DEVICE),
        // avdmanager asks whether to create a custom hardware profile; the device definition already has one.
        { env, input: "no\n", timeoutMs: 120_000, signal },
      );
    }
    await environment.inspect({ recheckAcceleration: true });
  }

  async #sdkmanager(
    sdkmanager: string,
    sdkRoot: string,
    packages: readonly string[],
    accepted: ReadonlySet<string>,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<void> {
    const runner = this.#deps.environment.deps.runner;
    const child = runner.spawn(sdkmanager, sdkmanagerInstallArgs(sdkRoot, packages), { env });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    const answers = new SdkmanagerLicenseResponder(accepted);
    let refused: string | undefined;
    let tail = "";
    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = `${tail}${text}`.slice(-4_000);
      const answer = answers.feed(text);
      if (answer) {
        if (answer.accept) child.write("y\n");
        else {
          refused = answer.licenseId;
          child.write("n\n");
        }
      }
      const progress = parseSdkmanagerProgress(text);
      if (progress)
        this.#report({ state: "running", stepId: "sdk", message: progress.message, percent: progress.percent });
    };
    child.onStdout(onOutput);
    child.onStderr((chunk) => {
      tail = `${tail}${chunk.toString("utf8")}`.slice(-4_000);
    });
    this.#report({ state: "running", stepId: "sdk", message: `Installing ${packages.join(", ")}` });
    const code = await child.exited;
    signal.removeEventListener("abort", abort);
    if (signal.aborted) throw new Error("Setup was cancelled.");
    if (refused) throw new LicenseNotAcceptedError([refused]);
    if (code !== 0)
      throw new Error(`${commandName(sdkmanager)} failed with exit code ${code}: ${tail.trim().slice(-1_500)}`);
  }

  #bytes(stepId: string, message: string, received: number, total: number | undefined): void {
    this.#report({
      state: "running",
      stepId,
      message,
      receivedBytes: received,
      ...(total ? { totalBytes: total } : {}),
    });
  }

  #report(progress: MobileSetupProgress): void {
    this.#progress = progress;
    this.#deps.onProgress?.(progress);
  }

  async #fetchText(url: string): Promise<string> {
    const response = await this.#deps.fetch(url);
    if (!response.ok) throw new Error(`Could not read ${url} (HTTP ${response.status}).`);
    return response.text();
  }

  async #fetchJson(url: string): Promise<unknown> {
    return JSON.parse(await this.#fetchText(url)) as unknown;
  }
}

export function sdkmanagerInstallArgs(sdkRoot: string, packages: readonly string[]): string[] {
  return [`--sdk_root=${sdkRoot}`, "--install", ...packages];
}

export function avdCreateArgs(name: string, systemImage: string, device: string): string[] {
  return ["create", "avd", "--name", name, "--package", systemImage, "--device", device];
}

/**
 * sdkmanager prints each license as "License <id>:", its text, then "Accept? (y/N):" and waits.
 * The responder answers only after it has seen which license the prompt is for.
 */
export class SdkmanagerLicenseResponder {
  readonly #accepted: ReadonlySet<string>;
  #buffer = "";

  constructor(accepted: ReadonlySet<string>) {
    this.#accepted = accepted;
  }

  feed(text: string): { licenseId: string; accept: boolean } | undefined {
    this.#buffer = `${this.#buffer}${text}`.slice(-200_000);
    const prompt = this.#buffer.search(/Accept\? \(y\/N\):/u);
    if (prompt < 0) return undefined;
    const before = this.#buffer.slice(0, prompt);
    this.#buffer = this.#buffer.slice(prompt + "Accept? (y/N):".length);
    const ids = [...before.matchAll(/License ([A-Za-z0-9._-]+):/gu)];
    const licenseId = ids.at(-1)?.[1] ?? "unknown";
    return { licenseId, accept: this.#accepted.has(licenseId) };
  }
}

export function parseSdkmanagerProgress(text: string): { percent: number; message: string } | undefined {
  const matches = [...text.matchAll(/\]\s*(\d{1,3})% ([^\r\n]*)/gu)];
  const last = matches.at(-1);
  if (!last?.[1]) return undefined;
  return { percent: Math.min(100, Number(last[1])), message: (last[2] ?? "").trim() || "Installing" };
}
