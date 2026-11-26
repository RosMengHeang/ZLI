import { Id16 } from "@zli-v2/remote-protocol";

/** The three socket paths. Kept apart from the Worker so it can be tested in plain Node. */
export interface Route {
  role: "control" | "phone" | "host";
  room: string;
  session?: string;
}

export function parseRoute(pathname: string): Route | null {
  const parts = pathname.split("/");
  // "/v1/<kind>/<room>[/<session>]" splits into ["", "v1", kind, room, session?].
  if (parts[0] !== "" || parts[1] !== "v1") return null;
  const [, , kind, room, session, ...rest] = parts;
  if (rest.length > 0 || room === undefined || !Id16.safeParse(room).success) return null;
  if (kind === "phone" && session === undefined) return { role: "phone", room };
  if (kind !== "host") return null;
  if (session === undefined) return { role: "control", room };
  return Id16.safeParse(session).success ? { role: "host", room, session } : null;
}

/** Header values are case-insensitive, so "WebSocket" counts as an upgrade too. */
export function isWebSocketUpgrade(request: Request): boolean {
  return request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/** An opaque per-client key for rate limits on the desktop: a short hash, never the address itself. */
export async function clientKey(request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The part of the Workers rate limit binding the relay uses. */
export interface UpgradeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/*
 * Upgrades per connecting address. Without the binding (a local run, or a deploy that left it out)
 * nothing is limited, so the check is skipped rather than failing every request.
 */
export async function withinRateLimit(limiter: UpgradeLimiter | undefined, request: Request): Promise<boolean> {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
  return success;
}
