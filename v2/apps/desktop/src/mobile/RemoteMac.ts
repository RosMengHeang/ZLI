import type { MobileIosHostTestResult, MobileIosStatus } from "@zli-v2/contracts";

import { type CommandHost, sshHostName } from "./CommandHost.js";
import { type IosTools, parseSimctlDevices } from "./IosSimulatorDriver.js";

/**
 * Prints simctl=yes when Xcode's simulator tools work, and idb=<path> for the first idb it finds, in the places
 * Homebrew and pip put it. The script is fixed text; nothing the person typed goes into it.
 */
export const REMOTE_PROBE_SCRIPT = [
  "if /usr/bin/xcrun simctl help >/dev/null 2>&1; then echo simctl=yes; else echo simctl=no; fi",
  'for candidate in "$(command -v idb 2>/dev/null)" /opt/homebrew/bin/idb /usr/local/bin/idb "$HOME/.local/bin/idb" "$HOME"/Library/Python/*/bin/idb; do',
  '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then echo "idb=$candidate"; break; fi',
  "done",
].join("\n");

const XCRUN = "/usr/bin/xcrun";

/** What ssh's error says went wrong, and what the person can do about it. */
export function sshProblem(host: string, stderr: string): string {
  const name = sshHostName(host);
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(stderr))
    return `This computer does not trust ${name} yet. Run ssh ${host} once in a terminal and accept the Mac's key, then test again.`;
  if (/Permission denied|publickey|Too many authentication failures/iu.test(stderr))
    return `${name} did not accept your SSH key. ZLI signs in with your key and never asks for a password. Add your public key to ~/.ssh/authorized_keys on the Mac, for example with ssh-copy-id ${host}, then test again.`;
  if (/Connection refused/iu.test(stderr))
    return `${name} refused the connection. Turn on Remote Login on the Mac in System Settings > General > Sharing, then test again.`;
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/iu.test(stderr))
    return `ZLI could not find ${name} on the network. Check the address, or use the Mac's IP address.`;
  if (/timed out|No route to host|Network is unreachable|Connection reset|Connection closed/iu.test(stderr))
    return `ZLI could not reach ${name}. Check that the Mac is awake and on the same network, and that Remote Login is on in System Settings > General > Sharing.`;
  const detail = stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  return `ssh could not connect to ${name}${detail ? `: ${detail.slice(0, 300)}` : "."}`;
}

/** The message for simctl failing on a Mac ZLI did reach. */
function xcodeProblem(host: string, stderr: string): string {
  const name = sshHostName(host);
  const detail = stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!detail || /xcrun: error|unable to find utility|command not found|xcode-select|No such file/iu.test(stderr))
    return `Connected to ${name}, but Xcode's simulator tools did not run there. Install Xcode on the Mac, open it once, then test again.`;
  return `Connected to ${name}, but simctl failed: ${detail.slice(0, 300)}`;
}

/** ssh exits with 255 when the connection or sign-in failed, before any command ran on the Mac. */
function sshFailed(result: { code: number | null; timedOut: boolean }): boolean {
  return result.timedOut || result.code === 255;
}

/** Finds Xcode and idb on the Mac, in the shape detectIosTools gives for this computer. */
export async function detectRemoteIosTools(host: CommandHost & { remote: string }): Promise<{
  tools: IosTools;
  status: MobileIosStatus;
}> {
  const name = sshHostName(host.remote);
  const result = await host.runner
    .run("/bin/sh", ["-c", REMOTE_PROBE_SCRIPT], { timeoutMs: 20_000 })
    .catch((cause: unknown) => ({
      code: -1,
      stdout: Buffer.alloc(0),
      stderr: cause instanceof Error ? cause.message : String(cause),
      timedOut: false,
    }));
  const base = { supported: true, host: host.remote };
  if (result.code !== 0 || sshFailed(result)) {
    return {
      tools: { host },
      status: {
        ...base,
        simctl: { found: false },
        idb: { found: false },
        missing: [sshProblem(host.remote, result.stderr)],
      },
    };
  }
  const lines = result.stdout.toString("utf8").split(/\r?\n/u);
  const simctl = lines.includes("simctl=yes");
  const idb = lines.find((line) => line.startsWith("idb="))?.slice("idb=".length);
  const missing: string[] = [];
  if (!simctl)
    missing.push(`Xcode with the iOS Simulator on ${name} (install Xcode from the App Store, then open it once)`);
  if (!idb)
    missing.push(
      `idb on ${name}, for taps, typing, and reading the screen (brew install facebook/fb/idb-companion and pip3 install fb-idb)`,
    );
  return {
    tools: { host, ...(simctl ? { xcrun: XCRUN } : {}), ...(idb ? { idb } : {}) },
    status: {
      ...base,
      simctl: simctl ? { found: true, path: XCRUN } : { found: false },
      idb: idb ? { found: true, path: idb } : { found: false },
      missing,
    },
  };
}

/** Test connection in Settings: signs in to the Mac, lists its simulators, and says what it found. */
export async function testRemoteMac(
  host: (CommandHost & { remote: string }) | undefined,
  address: string,
): Promise<MobileIosHostTestResult> {
  if (!host)
    return {
      ok: false,
      message:
        "ZLI could not find ssh on this computer. On Windows, add OpenSSH Client in Settings > System > Optional features, then test again.",
    };
  const name = sshHostName(address);
  const result = await host.runner
    .run(XCRUN, ["simctl", "list", "devices", "--json"], { timeoutMs: 20_000 })
    .catch((cause: unknown) => ({
      code: -1,
      stdout: Buffer.alloc(0),
      stderr: cause instanceof Error ? cause.message : String(cause),
      timedOut: false,
    }));
  if (sshFailed(result) || result.code === -1) return { ok: false, message: sshProblem(address, result.stderr) };
  if (result.code !== 0) return { ok: false, message: xcodeProblem(address, result.stderr) };
  let count: number;
  try {
    count = parseSimctlDevices(result.stdout.toString("utf8")).length;
  } catch {
    return { ok: false, message: `Connected to ${name}, but simctl's device list could not be read.` };
  }
  const tools = await detectRemoteIosTools(host);
  const noIdb = tools.tools.idb
    ? ""
    : " idb is not installed there, so the panel shows the screen but cannot tap or type. Install it with brew install facebook/fb/idb-companion and pip3 install fb-idb.";
  if (count === 0)
    return {
      ok: true,
      simulators: 0,
      message: `Connected to ${name}, but it has no iPhone simulators. Add one in Xcode under Window > Devices and Simulators.${noIdb}`,
    };
  return {
    ok: true,
    simulators: count,
    message: `Connected to ${name}. Found ${count} ${count === 1 ? "simulator" : "simulators"}.${noIdb}`,
  };
}
