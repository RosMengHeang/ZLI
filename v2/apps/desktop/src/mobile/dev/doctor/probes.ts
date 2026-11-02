import type { MobileDevHost } from "../host.js";

/** What the read-only version probes found on this computer. */
export type HostProbe = {
  /** A version, "not found", or "not checked" for tools that only run on a Mac. */
  tools: Record<string, string>;
  /** Valid code signing identities in the keychain, counted only. Undefined off macOS. */
  iosIdentities: number | undefined;
};

export const PROBE_TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;

type ProbeSpec = {
  readonly tool: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly macOnly?: boolean;
  parse(output: string): string | undefined;
};

export const PROBES: readonly ProbeSpec[] = [
  { tool: "node", command: "node", args: ["-v"], parse: (out) => /v?(\d+\.\d+\.\d+)/u.exec(out)?.[1] },
  {
    tool: "java",
    command: "java",
    args: ["-version"],
    parse: (out) => /version "([^"]+)"/u.exec(out)?.[1] ?? /(?:openjdk|java) (\d+(?:\.\d+)*)/u.exec(out)?.[1],
  },
  {
    tool: "adb",
    command: "adb",
    args: ["version"],
    parse: (out) => /^Version (\d[\w.-]*)/mu.exec(out)?.[1] ?? /version (\d+(?:\.\d+)+)/u.exec(out)?.[1],
  },
  {
    tool: "xcode",
    command: "xcodebuild",
    args: ["-version"],
    macOnly: true,
    parse: (out) => /Xcode (\d+(?:\.\d+)*)/u.exec(out)?.[1],
  },
  {
    tool: "cocoapods",
    command: "pod",
    args: ["--version"],
    macOnly: true,
    parse: (out) => /^(\d+\.\d+(?:\.\d+)?)/mu.exec(out.trim())?.[1],
  },
];

const cache = new WeakMap<MobileDevHost, { at: number; probe: Promise<HostProbe> }>();

/** The host's tool versions, cached for a minute per host. Each probe is read-only and gets five seconds. */
export function probeHost(host: MobileDevHost, options: { refresh?: boolean } = {}): Promise<HostProbe> {
  const now = host.now().getTime();
  const cached = cache.get(host);
  if (cached && !options.refresh && now - cached.at < CACHE_MS) return cached.probe;
  const probe = runProbes(host);
  cache.set(host, { at: now, probe });
  return probe;
}

async function runProbes(host: MobileDevHost): Promise<HostProbe> {
  const mac = host.os === "macos";
  const entries = await Promise.all(
    PROBES.map(async (spec): Promise<[string, string]> => {
      if (spec.macOnly && !mac) return [spec.tool, "not checked"];
      return [spec.tool, (await version(host, spec)) ?? "not found"];
    }),
  );
  return { tools: Object.fromEntries(entries), iosIdentities: mac ? await signingIdentities(host) : undefined };
}

async function version(host: MobileDevHost, spec: ProbeSpec): Promise<string | undefined> {
  try {
    const result = await host.runner.run(spec.command, spec.args, { env: host.env, timeoutMs: PROBE_TIMEOUT_MS });
    if (result.timedOut || result.code !== 0) return undefined;
    // java -version writes to stderr.
    return spec.parse(`${result.stdout.toString("utf8")}\n${result.stderr}`)?.slice(0, 60);
  } catch {
    return undefined;
  }
}

/** Only the "N valid identities found" count is kept; names and hashes of certificates never leave the probe. */
async function signingIdentities(host: MobileDevHost): Promise<number | undefined> {
  try {
    const result = await host.runner.run("security", ["find-identity", "-v", "-p", "codesigning"], {
      env: host.env,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.timedOut) return undefined;
    const count = /(\d+) valid identit(?:y|ies) found/u.exec(result.stdout.toString("utf8"))?.[1];
    return count === undefined ? undefined : Number.parseInt(count, 10);
  } catch {
    return undefined;
  }
}

/** The major Java version: 17 for "17.0.12", 8 for "1.8.0_391". */
export function javaMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const parts = version.split(/[._]/u).map((part) => Number.parseInt(part, 10));
  const value = parts[0] === 1 ? parts[1] : parts[0];
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}
