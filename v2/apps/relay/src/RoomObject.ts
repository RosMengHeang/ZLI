import { DurableObject } from "cloudflare:workers";

import { type PipeSocket, RelayRoom, type RestoredSocket, newSessionId } from "./RelayRoom.js";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
}

/** Headers the worker sets. Only the worker can reach a Durable Object, so they are trusted. */
export const ROLE_HEADER = "X-Relay-Role";
export const ROOM_HEADER = "X-Relay-Room";
export const SESSION_HEADER = "X-Relay-Session";
export const CLIENT_HEADER = "X-Relay-Client";

type Role = "control" | "phone" | "host";

interface Tagged {
  role: Role;
  room: string;
  session: string | undefined;
}

/*
 * A thin adapter: it accepts sockets with the Hibernation API and turns their events into RelayRoom
 * calls. Every socket is tagged with its role, room, and session, and the control socket stores
 * whether it holds the room. On wake the RelayRoom in memory is gone, so it is rebuilt from those
 * tags (see RelayRoom.restore): joined pairs carry on and half-open sessions are closed.
 */
export class RoomObject extends DurableObject<Env> {
  #room: RelayRoom | null = null;
  readonly #pipes = new WeakMap<WebSocket, PipeSocket>();

  override async fetch(request: Request): Promise<Response> {
    const role = request.headers.get(ROLE_HEADER);
    const roomId = request.headers.get(ROOM_HEADER);
    if (request.headers.get("Upgrade") !== "websocket" || !roomId || !isRole(role)) {
      return new Response("Not found", { status: 404 });
    }
    const room = this.#roomFor(roomId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (role === "control") {
      this.ctx.acceptWebSocket(server, ["control", `room:${roomId}`]);
    } else if (role === "phone") {
      const session = newSessionId();
      this.ctx.acceptWebSocket(server, ["phone", `room:${roomId}`, `session:${session}`]);
      room.phoneConnected(this.#pipe(server), request.headers.get(CLIENT_HEADER) ?? "unknown", session);
    } else {
      const session = request.headers.get(SESSION_HEADER);
      if (!session) return new Response("Not found", { status: 404 });
      this.ctx.acceptWebSocket(server, ["host", `room:${roomId}`, `session:${session}`]);
      room.sessionHostConnected(session, this.#pipe(server));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tagged = this.#tagged(ws);
    if (!tagged) return;
    const room = this.#roomFor(tagged.room);
    const pipe = this.#pipe(ws);
    if (tagged.role === "control") {
      const wasHost = room.isHost(pipe);
      room.hostControl(pipe, message);
      if (room.isHost(pipe) !== wasHost) this.#saveClaims(room);
    } else if (tagged.session) {
      room.onFrame(tagged.role, tagged.session, message, pipe);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.#closed(ws);
    // Finish the closing handshake; the socket may already be gone.
    try {
      ws.close(1000);
    } catch {}
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#closed(ws);
  }

  #closed(ws: WebSocket): void {
    const tagged = this.#tagged(ws);
    if (!tagged) return;
    const room = this.#roomFor(tagged.room);
    const pipe = this.#pipe(ws);
    if (tagged.role === "control") room.hostControlClosed(pipe);
    else if (tagged.session) room.onClose(tagged.role, tagged.session, pipe);
  }

  #roomFor(roomId: string): RelayRoom {
    if (this.#room) return this.#room;
    const room = new RelayRoom(roomId);
    const restored: RestoredSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const tagged = this.#tagged(ws);
      if (!tagged) continue;
      const socket = this.#pipe(ws);
      if (tagged.role === "control") {
        restored.push({ role: "control", socket, claimed: readClaimed(ws) });
      } else if (tagged.session) {
        restored.push({ role: tagged.role, session: tagged.session, socket });
      }
    }
    room.restore(restored);
    this.#room = room;
    return room;
  }

  /** Marks which control socket holds the room, so a wake does not hand it to a replaced one. */
  #saveClaims(room: RelayRoom): void {
    for (const ws of this.ctx.getWebSockets("control")) {
      ws.serializeAttachment({ claimed: room.isHost(this.#pipe(ws)) });
    }
  }

  #tagged(ws: WebSocket): Tagged | null {
    const tags = this.ctx.getTags(ws);
    const role = tags[0];
    const room = tagValue(tags, "room:");
    if (!isRole(role) || !room) return null;
    return { role, room, session: tagValue(tags, "session:") };
  }

  #pipe(ws: WebSocket): PipeSocket {
    let pipe = this.#pipes.get(ws);
    if (!pipe) {
      // Sends and closes on a socket that is already closing throw; the room treats them as no-ops.
      pipe = {
        send: (data) => {
          try {
            ws.send(data);
          } catch {}
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {}
        },
      };
      this.#pipes.set(ws, pipe);
    }
    return pipe;
  }
}

function isRole(value: string | null | undefined): value is Role {
  return value === "control" || value === "phone" || value === "host";
}

function tagValue(tags: readonly string[], prefix: string): string | undefined {
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function readClaimed(ws: WebSocket): boolean {
  const attachment: unknown = ws.deserializeAttachment();
  return (
    typeof attachment === "object" && attachment !== null && "claimed" in attachment && attachment.claimed === true
  );
}
