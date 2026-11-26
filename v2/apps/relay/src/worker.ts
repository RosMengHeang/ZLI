import { Id16 } from "@zli-v2/remote-protocol";

import { CLIENT_HEADER, type Env, ROLE_HEADER, ROOM_HEADER, SESSION_HEADER } from "./RoomObject.js";

export { RoomObject } from "./RoomObject.js";

/*
 * Routes WebSocket upgrades to one Durable Object per room. Anything else is a 404, so the relay
 * offers nothing to probe beyond the three socket paths.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = parseRoute(new URL(request.url).pathname);
    if (!route || request.headers.get("Upgrade") !== "websocket") {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers(request.headers);
    headers.set(ROLE_HEADER, route.role);
    headers.set(ROOM_HEADER, route.room);
    if (route.session) headers.set(SESSION_HEADER, route.session);
    else headers.delete(SESSION_HEADER);
    if (route.role === "phone") headers.set(CLIENT_HEADER, await clientKey(request));
    else headers.delete(CLIENT_HEADER);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(route.room));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

interface Route {
  role: "control" | "phone" | "host";
  room: string;
  session?: string;
}

function parseRoute(pathname: string): Route | null {
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

/** An opaque per-client key for rate limits on the desktop: a short hash, never the address itself. */
async function clientKey(request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
