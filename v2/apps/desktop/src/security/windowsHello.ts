import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import type { UserPresence } from "./userPresence.js";

/**
 * UNTESTED on a real Hello device: written against the WinRT KeyCredentialManager API, but not yet run end to end.
 *
 * Reaches WinRT through Windows PowerShell so ZLI needs no native module. The script is passed on the command line
 * and the challenge on stdin; the signature comes back on stdout and is never written to disk.
 *
 * The credential is a TPM-backed RSA key made once by Hello. Hello signs with RSA PKCS#1 v1.5, which gives the same
 * signature for the same input, so signing the file's challenge gives the same wrapping secret on every launch.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${"`"}1'
} | Select-Object -First 1
function Wait-Op($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}
$manager = [Windows.Security.Credentials.KeyCredentialManager]
if (-not (Wait-Op ($manager::IsSupportedAsync()) ([bool]))) { [Console]::Out.Write('unavailable'); exit 0 }
if ($args[0] -eq 'check') { [Console]::Out.Write('available'); exit 0 }
$name = 'ZLI connected apps'
$found = Wait-Op ($manager::OpenAsync($name)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
if ($found.Status -eq 'NotFound') {
  $found = Wait-Op ($manager::RequestCreateAsync($name, [Windows.Security.Credentials.KeyCredentialCreationOption]::FailIfExists)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
}
if ($found.Status -ne 'Success') { [Console]::Out.Write('cancelled'); exit 0 }
$challenge = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($challenge)
$signed = Wait-Op ($found.Credential.RequestSignAsync($buffer)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
if ($signed.Status -ne 'Success') { [Console]::Out.Write('cancelled'); exit 0 }
$bytes = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::ToArray($signed.Result)
[Console]::Out.Write('ok:' + [Convert]::ToBase64String($bytes))
`;

/** Runs the script with `mode` and `input` on stdin; resolves to its stdout. */
export type ScriptRunner = (mode: "check" | "sign", input: string) => Promise<string>;

const powershell: ScriptRunner = (mode, input) =>
  new Promise((resolve, reject) => {
    const encoded = Buffer.from(`& {${SCRIPT}} ${mode}`, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
    child.stdin.end(input);
  });

export function windowsHello(run: ScriptRunner = powershell): UserPresence {
  return {
    available: async () => (await run("check", "").catch(() => "")) === "available",
    secret: async (challenge) => {
      const out = await run("sign", challenge.toString("base64")).catch(() => "");
      if (!out.startsWith("ok:")) return undefined;
      // Hashed rather than used as is, so the wrapping key is a fixed size whatever the RSA key length.
      return createHash("sha256").update(Buffer.from(out.slice(3), "base64")).digest();
    },
  };
}
