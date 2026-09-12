import { invokeCmd } from "../../tauri/invoke.ts";
import type {
  BrowserCapability,
  BrowserControlStatus,
  BrowserSurfaceRecord,
} from "./browserProtocol.ts";

export interface RegisterBrowserSurfaceRequest {
  projectId: string;
  agentId?: string | null;
  webviewLabel: string;
  url: string;
  profileId: string;
  requestId?: string | null;
}

export interface CreatePanelWebviewRequest {
  label: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createBrowserBridge(invoke: BrowserInvoke = invokeCmd) {
  return {
    register(request: RegisterBrowserSurfaceRequest): Promise<BrowserSurfaceRecord> {
      return invoke<BrowserSurfaceRecord>("browser_register_surface", { request });
    },
    createPanel(request: CreatePanelWebviewRequest): Promise<void> {
      return invoke<void>("browser_create_panel_webview", { request });
    },
    rejectOpen(requestId: string): Promise<void> {
      return invoke<void>("browser_reject_open", { requestId });
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
    controlStatus(profileId = "clean"): Promise<BrowserControlStatus> {
      return invoke<BrowserControlStatus>("browser_control_status", { profileId });
    },
    setControlEnabled(profileId: string, enabled: boolean): Promise<BrowserControlStatus> {
      return invoke<BrowserControlStatus>("browser_control_set", { profileId, enabled });
    },
  };
}

const bridge = createBrowserBridge();

export function registerBrowserSurface(request: RegisterBrowserSurfaceRequest): Promise<BrowserSurfaceRecord> {
  return bridge.register(request);
}

export function createBrowserPanelWebview(request: CreatePanelWebviewRequest): Promise<void> {
  return bridge.createPanel(request);
}

export function rejectBrowserOpen(requestId: string): Promise<void> {
  return bridge.rejectOpen(requestId);
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

export function getBrowserControlStatus(profileId = "clean"): Promise<BrowserControlStatus> {
  return bridge.controlStatus(profileId);
}

export function setBrowserControlEnabled(profileId: string, enabled: boolean): Promise<BrowserControlStatus> {
  return bridge.setControlEnabled(profileId, enabled);
}
