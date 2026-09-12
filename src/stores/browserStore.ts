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
  getBrowserControlStatus,
  grantBrowserCapability,
  revokeBrowserCapability,
  setBrowserControlEnabled,
} from "../lib/browser/browserBridge.ts";
import type {
  BrowserCapability,
  BrowserControlStatus,
  BrowserSurfaceRecord,
} from "../lib/browser/browserProtocol.ts";
import type { AgentEventEnvelope, AgentEventPayload } from "../lib/agentEvents.ts";

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
  pendingOpen: { requestId: string; url: string } | null;
  permissionOpen: boolean;
  pendingCapability: BrowserCapability | null;
  error: string | null;
  automation: { phase: "running" | "completed" | "failed"; operation: string } | null;
  controlStatus: (BrowserControlStatus & { bridgeAvailable: boolean }) | null;
  controlLoading: boolean;
  setSurface: (surface: BrowserSurfaceRecord | null) => void;
  setPendingOpen: (pending: { requestId: string; url: string } | null) => void;
  setPermissionOpen: (open: boolean) => void;
  savedCapabilities: (projectId: string, profileId: string) => BrowserCapability[];
  restoreProfile: (projectId: string, profileId: string, capabilities: BrowserCapability[]) => void;
  setCapability: (capability: BrowserCapability, granted: boolean) => Promise<void>;
  refreshControlStatus: () => Promise<void>;
  setControlEnabled: (enabled: boolean) => Promise<void>;
  applyEvent: (event: AgentEventEnvelope) => void;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  registry: readRegistry(),
  surface: null,
  pendingOpen: null,
  permissionOpen: false,
  pendingCapability: null,
  error: null,
  automation: null,
  controlStatus: null,
  controlLoading: false,
  setSurface: (surface) => set({ surface, error: null }),
  setPendingOpen: (pendingOpen) => set({ pendingOpen }),
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
  refreshControlStatus: async () => {
    set({ controlLoading: true });
    try {
      const status = await getBrowserControlStatus("clean");
      set({ controlStatus: { ...status, bridgeAvailable: true }, controlLoading: false, error: null });
    } catch (error) {
      set({
        controlStatus: { profileId: "clean", enabled: false, surfaceCount: 0, bridgeAvailable: false },
        controlLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  setControlEnabled: async (enabled) => {
    set({ controlLoading: true, error: null });
    try {
      const status = await setBrowserControlEnabled("clean", enabled);
      set({ controlStatus: { ...status, bridgeAvailable: true }, controlLoading: false, error: null });
    } catch (error) {
      set({
        controlLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  applyEvent: (event) => {
    if (event.source !== "browser") return;
    const surface = get().surface;
    if (!surface || event.projectId !== surface.projectId) return;
    const payload = event.payload as AgentEventPayload;
    const operation = payload.type === "text" ? payload.text : "browser";
    if (event.kind === "browser_command_started") {
      set({ automation: { phase: "running", operation } });
    } else if (event.kind === "browser_command_completed") {
      set({ automation: { phase: "completed", operation } });
    } else if (event.kind === "browser_command_failed") {
      set({ automation: { phase: "failed", operation } });
    }
  },
}));
