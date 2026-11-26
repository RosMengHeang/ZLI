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
  const { success } = await limiter.limit({ key: rateLimitKey(request.headers.get("CF-Connecting-IP") ?? "unknown") });
  return success;
}

/*
 * IPv4 as it is. IPv6 by its /64, since one subscriber usually holds a whole /64 and could
 * otherwise get a fresh limit per address.
 */
export function rateLimitKey(address: string): string {
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  if (mapped?.[1]) return mapped[1];
  const groups = expandIPv6(address);
  if (!groups) return address;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** The eight groups of an IPv6 address, lowercased without leading zeros, or null if malformed. */
function expandIPv6(address: string): string[] | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const split = (part: string | undefined) => (part ? part.split(":") : []);
  const head = split(halves[0]);
  const tail = split(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16).toString(16));
}
