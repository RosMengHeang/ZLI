const SAFE_BROWSER_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

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
