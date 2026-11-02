import type { PushPlatform } from "@zli-v2/remote-protocol";

/** What the phone tells the desktop about push: a token, or null when notifications are off. */
export type PushRegistration = { token: string | null; platform: PushPlatform };

function projectIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The EAS project that push tokens are issued for, from the build or from app.json. Until `eas init`
 * adds one, there is no token to ask for and push stays off.
 */
export function easProjectId(
  expoConfig: { extra?: { eas?: { projectId?: unknown } } } | null | undefined,
  easConfig: { projectId?: unknown } | null | undefined,
): string | undefined {
  return projectIdOf(easConfig?.projectId) ?? projectIdOf(expoConfig?.extra?.eas?.projectId);
}
