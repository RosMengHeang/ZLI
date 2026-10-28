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
  /**
   * A secret a CLI saved in the system credential store: the Keychain on macOS, Credential Manager on
   * Windows, and the Secret Service on Linux. Without `account`, the first entry for `service`.
   */
  secretStore(service: string, account?: string): Promise<string | undefined>;
  now(): number;
};

export const READ_TIMEOUT_MS = 15_000;

export const defaultLimitReaderDeps = (home: string): LimitReaderDeps => {
  const keychain = async (service: string, account?: string) => {
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
  };
  return {
    fetch: (input, init) => fetch(input, init),
    platform: process.platform,
    home,
    env: process.env,
    readFile: (path) => readFile(path, "utf8"),
    keychain,
    secretStore: async (service, account) => {
      if (process.platform === "darwin") return keychain(service, account);
      if (process.platform === "win32") return windowsCredential(service, account);
      return secretServiceLookup(service, account);
    },
    now: () => Date.now(),
  };
};

/**
 * Node has no Credential Manager binding, so PowerShell calls advapi32 directly. keytar and most
 * Node CLIs save a generic credential named "<service>/<account>". The name travels in the
 * environment, never in the script, so nothing in it can change what runs.
 */
const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace ZliLimits -Name Credentials -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredEnumerateW(string filter, int flags, out int count, out IntPtr credentials);
[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
'@
$pointer = [IntPtr]::Zero
$credential = [IntPtr]::Zero
if ($env:ZLI_CREDENTIAL_FILTER) {
  $count = 0
  if (-not [ZliLimits.Credentials]::CredEnumerateW($env:ZLI_CREDENTIAL_FILTER, 0, [ref]$count, [ref]$pointer) -or $count -lt 1) { exit 3 }
  $credential = [Runtime.InteropServices.Marshal]::ReadIntPtr($pointer)
} else {
  if (-not [ZliLimits.Credentials]::CredReadW($env:ZLI_CREDENTIAL_TARGET, 1, 0, [ref]$pointer)) { exit 3 }
  $credential = $pointer
}
$entry = [Runtime.InteropServices.Marshal]::PtrToStructure($credential, [type][ZliLimits.Credentials+CREDENTIAL])
$bytes = New-Object byte[] $entry.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($entry.CredentialBlob, $bytes, 0, $entry.CredentialBlobSize)
[ZliLimits.Credentials]::CredFree($pointer)
[Convert]::ToBase64String($bytes)
`;

async function windowsCredential(service: string, account: string | undefined): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
      {
        timeout: 15_000,
        windowsHide: true,
        env: {
          ...process.env,
          ...(account ? { ZLI_CREDENTIAL_TARGET: `${service}/${account}` } : { ZLI_CREDENTIAL_FILTER: `${service}*` }),
        },
      },
    );
    return credentialText(Buffer.from(stdout.trim(), "base64"));
  } catch {
    return undefined;
  }
}

async function secretServiceLookup(service: string, account: string | undefined): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "secret-tool",
      ["lookup", "service", service, ...(account ? ["account", account] : [])],
      { timeout: 5_000, windowsHide: true },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Credential Manager keeps bytes; Node CLIs write UTF-8, while native Windows apps write UTF-16. */
export function credentialText(bytes: Buffer): string | undefined {
  if (bytes.length === 0) return undefined;
  const wide =
    bytes.length % 2 === 0 && bytes.length >= 2 && bytes.every((byte, index) => index % 2 === 0 || byte === 0);
  return (wide ? bytes.toString("utf16le") : bytes.toString("utf8")).trim() || undefined;
}

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
