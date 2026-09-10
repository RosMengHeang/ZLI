import { invokeCmd } from "../../tauri/invoke.ts";
import type { BrowserCapability, BrowserSurfaceRecord } from "./browserProtocol.ts";

export interface RegisterBrowserSurfaceRequest {
  projectId: string;
  agentId?: string | null;
  webviewLabel: string;
  url: string;
  profileId: string;
}

export type BrowserInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createBrowserBridge(invoke: BrowserInvoke = invokeCmd) {
  return {
    register(request: RegisterBrowserSurfaceRequest): Promise<BrowserSurfaceRecord> {
      return invoke<BrowserSurfaceRecord>("browser_register_surface", { request });
    },
    navigation(surfaceId: string, url: string): Promise<BrowserSurfaceRecord> {
      return invoke<BrowserSurfaceRecord>("browser_update_navigation", { surfaceId, url });
    },
    grant(surfaceId: string, capability: BrowserCapability): Promise<BrowserSurfaceRecord> {
      return invoke<BrowserSurfaceRecord>("browser_grant_capability", { surfaceId, capability });
    },
    revoke(surfaceId: string, capability: BrowserCapability): Promise<BrowserSurfaceRecord> {
      return invoke<BrowserSurfaceRecord>("browser_revoke_capability", { surfaceId, capability });
    },
    close(surfaceId: string): Promise<BrowserSurfaceRecord> {
      return invoke<BrowserSurfaceRecord>("browser_close_surface", { surfaceId });
    },
  };
}

const bridge = createBrowserBridge();

export function registerBrowserSurface(request: RegisterBrowserSurfaceRequest): Promise<BrowserSurfaceRecord> {
  return bridge.register(request);
}

export function updateBrowserNavigation(surfaceId: string, url: string): Promise<BrowserSurfaceRecord> {
  return bridge.navigation(surfaceId, url);
}

export function grantBrowserCapability(
  surfaceId: string,
  capability: BrowserCapability,
): Promise<BrowserSurfaceRecord> {
  return bridge.grant(surfaceId, capability);
}

export function revokeBrowserCapability(
  surfaceId: string,
  capability: BrowserCapability,
): Promise<BrowserSurfaceRecord> {
  return bridge.revoke(surfaceId, capability);
}

export function closeBrowserSurface(surfaceId: string): Promise<BrowserSurfaceRecord> {
  return bridge.close(surfaceId);
}
