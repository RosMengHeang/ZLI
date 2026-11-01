/** Variables that give access to ZLI's runtime, daemon, or agent control service. No child process gets them. */
export const PRIVATE_ENV_KEYS = [
  "ZLI_RUNTIME_TOKEN",
  "ZLI_DAEMON_TOKEN",
  "ZLI_DAEMON_ENDPOINT_PATH",
  "ZLI_BROWSER_CONTROL_FILE",
] as const;

/** A copy of env for the tools mobile features start, without ZLI's private variables. */
export function mobileChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    // Windows environment names are case-insensitive, so a differently cased copy must go too.
    if ((PRIVATE_ENV_KEYS as readonly string[]).includes(key.toUpperCase())) delete copy[key];
  }
  return copy;
}
