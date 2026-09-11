export interface ProviderLaunchFailureDetails {
  providerName: string;
  cwd: string;
  exitCode?: number | null;
  reason?: string | null;
}

function normalizedReason(reason: string | null | undefined): string | null {
  const value = reason?.trim();
  return value ? value : null;
}

export function providerLaunchFailureMessage({
  providerName,
  cwd,
  exitCode,
  reason,
}: ProviderLaunchFailureDetails): string {
  const realReason = normalizedReason(reason);
  if (realReason) return `${providerName}: ${realReason}`;

  const code = typeof exitCode === "number" ? ` (exit code ${exitCode})` : "";
  return `${providerName} exited during startup${code} in "${cwd}". Open the terminal output, then verify the CLI is authenticated and available in this folder.`;
}
