import { describe, expect, it } from "vitest";

import {
  isAllowedBrowserNavigation,
  isAllowedMainNavigation,
  isPermissionAllowed,
  RENDERER_CONTENT_SECURITY_POLICY,
  shouldOpenExternal,
  withRendererPolicy,
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

  it("denies sensitive permissions while allowing sanitized clipboard writes", () => {
    expect(isPermissionAllowed("clipboard-sanitized-write")).toBe(true);
    expect(isPermissionAllowed("clipboard-read")).toBe(false);
    expect(isPermissionAllowed("clipboard-write")).toBe(false);
    expect(isPermissionAllowed("notifications")).toBe(false);
    expect(isPermissionAllowed("geolocation")).toBe(false);
    expect(isPermissionAllowed("camera")).toBe(false);
    expect(isPermissionAllowed("microphone")).toBe(false);
    expect(isPermissionAllowed("midi")).toBe(false);
  });
});

describe("renderer content security policy", () => {
  it("runs only the app's own scripts and blocks plugins, base changes, and form posts", () => {
    const directives = new Map(
      RENDERER_CONTENT_SECURITY_POLICY.split("; ").map((entry) => {
        const [name = "", ...values] = entry.split(" ");
        return [name, values] as const;
      }),
    );
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });

  it("adds the policy to a response and keeps its body and status", async () => {
    const response = withRendererPolicy(
      new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("<p>hi</p>");
  });
});
