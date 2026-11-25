const SAFE_BROWSER_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

/**
 * The Content Security Policy for every page the app window loads. The window can reach the preload API, so a script
 * that got into a page through agent output or a pull request would act with the app's full power. Only the app's
 * own scripts run. Images may come from the web (site icons, pictures in Markdown the reader allowed). Inline styles
 * stay, since components set them.
 */
export const RENDERER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The response with the app's policy added, so it holds before any markup in the page is parsed. */
export function withRendererPolicy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", RENDERER_CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function isAllowedMainNavigation(candidate: string, appOrigin: string): boolean {
  const url = parse(candidate);
  const origin = parse(appOrigin);
  return url !== undefined && origin !== undefined && url.origin === origin.origin && url.protocol === origin.protocol;
}

/** Frames inside the app window only ever show inline documents. */
export function isAllowedSubframeNavigation(candidate: string): boolean {
  return candidate === "about:srcdoc" || candidate === "about:blank";
}

export function isAllowedBrowserNavigation(candidate: string): boolean {
  const url = parse(candidate);
  return (
    url?.protocol === "http:" ||
    url?.protocol === "https:" ||
    (url?.protocol === "about:" && url.href === "about:blank")
  );
}

export function shouldOpenExternal(candidate: string): boolean {
  return isAllowedBrowserNavigation(candidate);
}

export function isPermissionAllowed(permission: string): boolean {
  return SAFE_BROWSER_PERMISSIONS.has(permission);
}

function parse(candidate: string): URL | undefined {
  try {
    const url = new URL(candidate);
    if (url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
