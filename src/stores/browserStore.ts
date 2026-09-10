import { create } from "zustand";
import {
  capabilitiesFor,
  EMPTY_BROWSER_PERMISSIONS,
  normalizeBrowserPermissions,
  replaceBrowserCapabilities,
  setBrowserCapability,
  type BrowserPermissionRegistry,
} from "../lib/browser/browserPermissions.ts";
import {
  grantBrowserCapability,
  revokeBrowserCapability,
} from "../lib/browser/browserBridge.ts";
import type { BrowserCapability, BrowserSurfaceRecord } from "../lib/browser/browserProtocol.ts";

const STORAGE_KEY = "taxzy:browser-permissions";

function readRegistry(): BrowserPermissionRegistry {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeBrowserPermissions(JSON.parse(raw)) : EMPTY_BROWSER_PERMISSIONS;
  } catch {
    return EMPTY_BROWSER_PERMISSIONS;
  }
}

function persist(registry: BrowserPermissionRegistry): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // Permission changes still apply to the live surface when storage is unavailable.
  }
}

interface BrowserState {
  registry: BrowserPermissionRegistry;
  surface: BrowserSurfaceRecord | null;
  permissionOpen: boolean;
  pendingCapability: BrowserCapability | null;
  error: string | null;
  setSurface: (surface: BrowserSurfaceRecord | null) => void;
  setPermissionOpen: (open: boolean) => void;
  savedCapabilities: (projectId: string, profileId: string) => BrowserCapability[];
  restoreProfile: (projectId: string, profileId: string, capabilities: BrowserCapability[]) => void;
  setCapability: (capability: BrowserCapability, granted: boolean) => Promise<void>;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  registry: readRegistry(),
  surface: null,
  permissionOpen: false,
  pendingCapability: null,
  error: null,
  setSurface: (surface) => set({ surface, error: null }),
  setPermissionOpen: (permissionOpen) => set({ permissionOpen }),
  savedCapabilities: (projectId, profileId) => capabilitiesFor(get().registry, projectId, profileId),
  restoreProfile: (projectId, profileId, capabilities) => {
    const registry = replaceBrowserCapabilities(get().registry, projectId, profileId, capabilities);
    persist(registry);
    set({ registry });
  },
  setCapability: async (capability, granted) => {
    const surface = get().surface;
    if (!surface) return;
    set({ pendingCapability: capability, error: null });
    try {
      const nextSurface = granted
        ? await grantBrowserCapability(surface.surfaceId, capability)
        : await revokeBrowserCapability(surface.surfaceId, capability);
      const registry = setBrowserCapability(
        get().registry,
        surface.projectId,
        surface.profileId,
        capability,
        granted,
      );
      persist(registry);
      set({ surface: nextSurface, registry, pendingCapability: null });
    } catch (error) {
      set({
        pendingCapability: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));
