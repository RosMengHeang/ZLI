import { MobileSshHost } from "@zli-v2/contracts";

import { findOnPath, type HostOs, type MobileFileSystem, pathFor } from "./host.js";
import type { ProcessRunner, RunOptions, SpawnOptions } from "./ProcessRunner.js";

/** Where simulator commands run: this computer, or a Mac reached over SSH. */
export type CommandHost = {
  /** The SSH address of the Mac, such as you@mac-mini.local. Absent for this computer. */
  readonly remote?: string;
  readonly runner: ProcessRunner;
};

/**
 * BatchMode makes ssh fail at once instead of asking for a password or a host key nobody can answer, and
 * ConnectTimeout keeps an asleep or unreachable Mac from holding a command for minutes.
 */
export const SSH_OPTIONS: readonly string[] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

/**
 * A non-interactive SSH session on macOS gets only /usr/bin:/bin:/usr/sbin:/sbin, so the folders Homebrew uses
 * come first. idb finds idb_companion on PATH.
 */
const REMOTE_PATH = "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH";

/** Quotes one argument for the POSIX shell sshd runs the command in, so no character in it is special there. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The single command line ssh sends to the Mac, with every argument quoted. */
export function remoteCommandLine(command: string, args: readonly string[]): string {
  return [REMOTE_PATH, ...[command, ...args].map(shellQuote)].join(" ");
}

/** ssh's own arguments. The `--` and the host check keep the address from being read as an ssh option. */
export function sshArgs(host: string, command: string, args: readonly string[]): string[] {
  return [...SSH_OPTIONS, "--", MobileSshHost.parse(host), remoteCommandLine(command, args)];
}

/** The address without its user name, which is how the Mac is named on screen. */
export function sshHostName(host: string): string {
  return host.slice(host.lastIndexOf("@") + 1);
}

/** A runner that runs every command on the Mac at host through the local ssh client and the person's own key. */
export function sshCommandHost(options: { runner: ProcessRunner; ssh: string; host: string }): CommandHost {
  const { runner, ssh, host } = options;
  // A local working folder means nothing on the Mac, and ssh itself must not run in one that may not exist.
  const local = <T extends RunOptions | SpawnOptions>(given: T | undefined): T | undefined => {
    if (!given || given.cwd === undefined) return given;
    const { cwd: _cwd, ...rest } = given;
    return rest as T;
  };
  return {
    remote: host,
    runner: {
      run: (command, args, runOptions) => runner.run(ssh, sshArgs(host, command, args), local(runOptions)),
      spawn: (command, args, spawnOptions) => runner.spawn(ssh, sshArgs(host, command, args), local(spawnOptions)),
    },
  };
}

/** The OpenSSH client: on PATH, or where Windows installs it as an optional feature. */
export async function findSsh(env: NodeJS.ProcessEnv, os: HostOs, fs: MobileFileSystem): Promise<string | undefined> {
  const found = await findOnPath("ssh", env, os, fs);
  if (found) return found;
  const candidates =
    os === "windows"
      ? [pathFor(os).join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe")]
      : ["/usr/bin/ssh"];
  for (const candidate of candidates) if (await fs.exists(candidate)) return candidate;
  return undefined;
}
