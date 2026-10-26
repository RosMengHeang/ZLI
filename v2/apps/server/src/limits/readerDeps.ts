import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What a limits reader may touch, so tests can swap the network, files, and Keychain. */
export type LimitReaderDeps = {
  fetch: typeof fetch;
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  readFile(path: string): Promise<string>;
  /** The macOS Keychain item's password, or undefined when there is none. */
  keychain(service: string, account?: string): Promise<string | undefined>;
  now(): number;
};

export const READ_TIMEOUT_MS = 15_000;

export const defaultLimitReaderDeps = (home: string): LimitReaderDeps => ({
  fetch: (input, init) => fetch(input, init),
  platform: process.platform,
  home,
  env: process.env,
  readFile: (path) => readFile(path, "utf8"),
  keychain: async (service, account) => {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"],
        { timeout: 5_000, windowsHide: true },
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
  now: () => Date.now(),
});

/** The provider's answer, or undefined when it could not be reached in time. */
export async function send(deps: LimitReaderDeps, url: string, init: RequestInit = {}): Promise<Response | undefined> {
  try {
    return await deps.fetch(url, { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch {
    return undefined;
  }
}

/** The answer's JSON body, or undefined when it is not JSON. */
export async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
