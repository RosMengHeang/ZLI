import type { BrowserCapability } from "./browserProtocol.ts";

export const USER_GRANTABLE_BROWSER_CAPABILITIES = [
  "browser.read",
  "browser.control",
  "browser.javascript",
] as const satisfies readonly BrowserCapability[];

export interface BrowserPermissionProfile {
  projectId: string;
  profileId: string;
  capabilities: BrowserCapability[];
}

export interface BrowserPermissionRegistry {
  profiles: BrowserPermissionProfile[];
}

export const EMPTY_BROWSER_PERMISSIONS: BrowserPermissionRegistry = { profiles: [] };

export function normalizeBrowserPermissions(value: unknown): BrowserPermissionRegistry {
  if (!value || typeof value !== "object" || !Array.isArray((value as BrowserPermissionRegistry).profiles)) {
    return EMPTY_BROWSER_PERMISSIONS;
  }
  const profiles = (value as BrowserPermissionRegistry).profiles.flatMap((profile) => {
    if (!profile || typeof profile.projectId !== "string" || !profile.projectId.trim()
      || typeof profile.profileId !== "string" || !profile.profileId.trim()
      || !Array.isArray(profile.capabilities)) return [];
    const capabilities = [...new Set(profile.capabilities.filter(
      (capability): capability is BrowserCapability =>
        USER_GRANTABLE_BROWSER_CAPABILITIES.includes(capability as typeof USER_GRANTABLE_BROWSER_CAPABILITIES[number]),
    ))];
    return [{ projectId: profile.projectId, profileId: profile.profileId, capabilities }];
  });
  return { profiles };
}

export function capabilitiesFor(
  registry: BrowserPermissionRegistry,
  projectId: string,
  profileId: string,
): BrowserCapability[] {
  return registry.profiles.find(
    (profile) => profile.projectId === projectId && profile.profileId === profileId,
  )?.capabilities ?? [];
}

export function setBrowserCapability(
  registry: BrowserPermissionRegistry,
  projectId: string,
  profileId: string,
  capability: BrowserCapability,
  granted: boolean,
): BrowserPermissionRegistry {
  if (!USER_GRANTABLE_BROWSER_CAPABILITIES.includes(
    capability as typeof USER_GRANTABLE_BROWSER_CAPABILITIES[number],
  )) return registry;
  const current = capabilitiesFor(registry, projectId, profileId);
  const capabilities = granted
    ? [...new Set([...current, capability])]
    : current.filter((item) => item !== capability);
  const profiles = registry.profiles.filter(
    (profile) => profile.projectId !== projectId || profile.profileId !== profileId,
  );
  return { profiles: [...profiles, { projectId, profileId, capabilities }] };
}
