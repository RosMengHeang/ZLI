import { CLIENT_HEADER, type Env, ROLE_HEADER, ROOM_HEADER, SESSION_HEADER } from "./RoomObject.js";
import { clientKey, isWebSocketUpgrade, parseRoute, withinRateLimit } from "./routes.js";

export { RelayCounter } from "./RelayCounter.js";
export { RoomObject } from "./RoomObject.js";

/*
 * Routes WebSocket upgrades to one Durable Object per room. Anything else is a 404, so the relay
 * offers nothing to probe beyond the three socket paths. Every request counts against the
 * per-address limit first, so probing costs the same as connecting.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await withinRateLimit(env.UPGRADES, request))) {
      return new Response("Too many requests", { status: 429 });
    }
    const route = parseRoute(new URL(request.url).pathname);
    if (!route || !isWebSocketUpgrade(request)) {
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
