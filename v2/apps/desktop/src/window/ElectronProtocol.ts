import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a renderer asset without allowing the custom app scheme to escape
 * the packaged renderer directory. The Electron protocol handler delegates
 * the actual file read to Electron's `net.fetch` implementation.
 */
export function resolveAppAsset(rendererRoot: string, candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "zli-v2:" || url.hostname !== "app" || url.username || url.password) return undefined;

  const rawPath = candidate.slice(candidate.indexOf("://") + 3).split(/[?#]/u, 1)[0] ?? "";
  if (/(?:^|\/)\.\.(?:\/|$)/u.test(rawPath) || /%2e|%2f|%5c/iu.test(rawPath)) return undefined;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return undefined;

  const root = resolve(rendererRoot);
  const asset = resolve(root, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  const distance = relative(root, asset);
  if (distance === ".." || distance.startsWith(`..${sep}`) || isAbsolute(distance)) return undefined;
  return asset;
}
