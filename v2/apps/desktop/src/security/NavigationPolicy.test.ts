import { describe, expect, it } from "vitest";

import {
  isAllowedBrowserNavigation,
  isAllowedMainNavigation,
  isPermissionAllowed,
  shouldOpenExternal,
} from "./NavigationPolicy.js";

describe("NavigationPolicy", () => {
  it("keeps the application shell on its own origin", () => {
    expect(isAllowedMainNavigation("zli-v2://app/index.html", "zli-v2://app")).toBe(true);
    expect(isAllowedMainNavigation("https://example.com", "zli-v2://app")).toBe(false);
    expect(isAllowedMainNavigation("file:///etc/passwd", "zli-v2://app")).toBe(false);
  });

  it("allows Chromium browser pages but never script, file, or custom schemes", () => {
    expect(isAllowedBrowserNavigation("https://example.com/login")).toBe(true);
    expect(isAllowedBrowserNavigation("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedBrowserNavigation("about:blank")).toBe(true);
    expect(isAllowedBrowserNavigation("javascript:alert(1)")).toBe(false);
    expect(isAllowedBrowserNavigation("file:///tmp/index.html")).toBe(false);
    expect(shouldOpenExternal("https://example.com")).toBe(true);
    expect(shouldOpenExternal("mailto:test@example.com")).toBe(false);
  });

  it("defaults permissions to deny and allows only the explicit safe browser set", () => {
    expect(isPermissionAllowed("clipboard-read")).toBe(true);
    expect(isPermissionAllowed("clipboard-sanitized-write")).toBe(true);
    expect(isPermissionAllowed("camera")).toBe(false);
    expect(isPermissionAllowed("midi")).toBe(false);
  });
});
