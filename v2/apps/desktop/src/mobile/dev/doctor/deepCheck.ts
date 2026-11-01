import type { MobileDoctorDeep, MobileDoctorDeepPlan, MobileDoctorDeepStep } from "@zli-v2/contracts";

import { pathFor } from "../../host.js";
import type { MobileDevHost } from "../host.js";
import { findAppDir } from "./readProject.js";

export const DEEP_TIMEOUT_MS = 60_000;

type Step = {
  readonly key: "expoConfig" | "expoInstallCheck" | "expoDoctor";
  /** The local binary npx --no-install needs in node_modules/.bin. */
  readonly bin: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

const STEPS: readonly Step[] = [
  { key: "expoConfig", bin: "expo", args: ["--no-install", "expo", "config", "--json", "--type", "public"] },
  { key: "expoInstallCheck", bin: "expo", args: ["--no-install", "expo", "install", "--check"], env: { CI: "1" } },
  { key: "expoDoctor", bin: "expo-doctor", args: ["--no-install", "expo-doctor"] },
];

const results = new WeakMap<MobileDevHost, Map<string, MobileDoctorDeep>>();

/** The last Expo check results for a worktree, kept in memory until ZLI quits. */
export function lastDeep(host: MobileDevHost, worktreeId: string): MobileDoctorDeep | undefined {
  return results.get(host)?.get(worktreeId);
}

function lineOf(step: Step): string {
  const env = Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value}`);
  return [...env, "npx", ...step.args].join(" ");
}

async function locate(host: MobileDevHost, worktreeId: string): Promise<{ root: string; appDir: string }> {
  const root = host.worktreePath(worktreeId);
  if (!root) throw new Error("That worktree is not in ZLI.");
  const appDir = await findAppDir(host.fs, root, host.os);
  if (appDir === undefined) throw new Error("No mobile app found in this worktree.");
  return { root, appDir };
}

/** The exact lines Run Expo checks runs, so the person sees them before anything runs. */
export async function deepPlan(host: MobileDevHost, worktreeId: string): Promise<MobileDoctorDeepPlan> {
  const { appDir } = await locate(host, worktreeId);
  return { folder: appDir, commands: STEPS.map(lineOf) };
}

/**
 * Runs the Expo checks. They execute the project's own code, so the only caller is the renderer's Run button,
 * after it showed deepPlan's lines; agents and the doctor's facts only ever read the last results.
 */
export async function runDeep(host: MobileDevHost, worktreeId: string): Promise<MobileDoctorDeep> {
  const { root, appDir } = await locate(host, worktreeId);
  const path = pathFor(host.os);
  const dir = appDir === "." ? root : path.join(root, ...appDir.split("/"));
  const npx = host.os === "windows" ? "npx.cmd" : "npx";
  const outcome: MobileDoctorDeep = { ranAt: host.now().toISOString() };
  for (const step of STEPS) {
    if (!(await hasBin(host, root, dir, step.bin))) {
      setStep(outcome, step.key, { ok: false, state: "not-installed", detail: "Not installed in this project." });
      continue;
    }
    let stdout = "";
    let stderr = "";
    let code: number | null = null;
    let timedOut = false;
    try {
      const result = await host.runner.run(npx, step.args, {
        cwd: dir,
        env: { ...host.env, ...step.env },
        timeoutMs: DEEP_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      stdout = result.stdout.toString("utf8");
      stderr = result.stderr;
      code = result.code;
      timedOut = result.timedOut;
    } catch (cause) {
      stderr = cause instanceof Error ? cause.message : String(cause);
      code = -1;
    }
    if (timedOut) {
      setStep(outcome, step.key, { ok: false, state: "timed-out", detail: "Did not finish in 60 seconds." });
      continue;
    }
    setStep(outcome, step.key, parseStep(step.key, code, stdout, stderr));
  }
  const map = results.get(host) ?? new Map<string, MobileDoctorDeep>();
  map.set(worktreeId, outcome);
  results.set(host, map);
  return outcome;
}

function setStep(outcome: MobileDoctorDeep, key: Step["key"], step: ReturnType<typeof parseStep>): void {
  if (key === "expoConfig") outcome.expoConfig = step;
  else if (key === "expoInstallCheck") outcome.expoInstallCheck = { packages: [], ...step };
  else outcome.expoDoctor = { failures: [], ...step };
}

type ParsedStep = MobileDoctorDeepStep & { sdkVersion?: string; packages?: string[]; failures?: string[] };

export function parseStep(key: Step["key"], code: number | null, stdout: string, stderr: string): ParsedStep {
  const output = stripAnsi(`${stdout}\n${stderr}`);
  const tail = lastLines(output, 12);
  if (key === "expoConfig") {
    const config = parseConfig(stdout);
    if (code === 0 && config)
      return { ok: true, state: "passed", ...(config.sdkVersion ? { sdkVersion: config.sdkVersion } : {}) };
    return { ok: false, state: "failed", ...(tail ? { detail: tail } : {}) };
  }
  if (key === "expoInstallCheck") {
    const packages = [
      ...new Set(
        [...output.matchAll(/^\s*(@?[\w.-]+(?:\/[\w.-]+)?)@[\w.^~<>=-]+\s+-\s+expected version/gmu)].map(
          (match) => match[1] ?? "",
        ),
      ),
    ]
      .filter(Boolean)
      .slice(0, 100);
    const ok = code === 0 && packages.length === 0;
    return { ok, state: ok ? "passed" : "failed", packages, ...(!ok && tail ? { detail: tail } : {}) };
  }
  const failures = [...output.matchAll(/^\s*[✖✗×]\s*(.+?)\s*$/gmu)]
    .map((match) => (match[1] ?? "").slice(0, 300))
    .filter(Boolean)
    .slice(0, 50);
  const ok = code === 0 && failures.length === 0;
  return {
    ok,
    state: ok ? "passed" : "failed",
    failures,
    ...(!ok && failures.length === 0 && tail ? { detail: tail } : {}),
  };
}

function parseConfig(stdout: string): { sdkVersion?: string } | undefined {
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  try {
    const value: unknown = JSON.parse(stdout.slice(start));
    if (typeof value !== "object" || value === null) return undefined;
    const sdk = (value as { sdkVersion?: unknown }).sdkVersion;
    return typeof sdk === "string" ? { sdkVersion: sdk.slice(0, 60) } : {};
  } catch {
    return undefined;
  }
}

/** npx --no-install finds a binary in the app's node_modules/.bin or one hoisted up to the worktree root. */
async function hasBin(host: MobileDevHost, root: string, dir: string, bin: string): Promise<boolean> {
  const path = pathFor(host.os);
  const names = host.os === "windows" ? [`${bin}.cmd`, bin] : [bin];
  let current = dir;
  for (;;) {
    for (const name of names) if (await host.fs.exists(path.join(current, "node_modules", ".bin", name))) return true;
    if (current === root) return false;
    const parent = path.dirname(current);
    if (parent === current || path.relative(root, parent).startsWith("..")) return false;
    current = parent;
  }
}

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes start with ESC.
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "");
}

function lastLines(text: string, count: number): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join("\n")
    .slice(-2_000);
}
