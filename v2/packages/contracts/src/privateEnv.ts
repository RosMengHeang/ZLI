/**
 * Variables that let a process drive ZLI itself: its runtime, its daemon, or the agent control service.
 * A process ZLI starts for a feature never inherits them.
 */
export const ZLI_PRIVATE_ENV_KEYS = [
  "ZLI_RUNTIME_TOKEN",
  "ZLI_DAEMON_TOKEN",
  "ZLI_DAEMON_ENDPOINT_PATH",
  "ZLI_BROWSER_CONTROL_FILE",
] as const;

/**
 * The one private variable an agent terminal keeps: its browser and zli-mobile tools authenticate to ZLI
 * through this control file, so the PTY factory keeps it while stripping the rest.
 */
export const ZLI_AGENT_CONTROL_ENV = "ZLI_BROWSER_CONTROL_FILE";

/**
 * A copy of env without ZLI's private variables. Windows environment names are case-insensitive, so a
 * differently cased copy goes too. `keep` names private variables to leave in, in any casing.
 */
export function withoutPrivateEnv(
  env: Record<string, string | undefined>,
  options?: { keep?: readonly string[] },
): Record<string, string | undefined> {
  const keep = new Set((options?.keep ?? []).map((key) => key.toUpperCase()));
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (keep.has(key.toUpperCase())) continue;
    if ((ZLI_PRIVATE_ENV_KEYS as readonly string[]).includes(key.toUpperCase())) delete copy[key];
  }
  return copy;
}
