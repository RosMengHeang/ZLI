import { DurableObject } from "cloudflare:workers";

import { type PipeSocket, RelayRoom, type RestoredSocket, newSessionId } from "./RelayRoom.js";
import { isWebSocketUpgrade } from "./routes.js";

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
 * A socket as RelayRoom sees it. Until the Durable Object has accepted the socket it only records
 * what the room asked for, so the DO can pick how to accept it once the room has decided.
 */
class SocketPipe implements PipeSocket {
  readonly #ws: WebSocket;
  #accepted: boolean;
  #queued: Array<string | ArrayBuffer> = [];
  closeRequest: { code: number; reason: string | undefined } | null = null;

  constructor(ws: WebSocket, accepted: boolean) {
    this.#ws = ws;
    this.#accepted = accepted;
  }

  send(data: string | ArrayBuffer): void {
    if (!this.#accepted) {
      this.#queued.push(data);
      return;
    }
    // Sends and closes on a socket that is already closing throw; the room treats them as no-ops.
    try {
      this.#ws.send(data);
    } catch {}
  }

  close(code: number, reason?: string): void {
    if (!this.#accepted) {
      this.closeRequest ??= { code, reason };
      return;
    }
    try {
      this.#ws.close(code, reason);
    } catch {}
  }

  accepted(): void {
    this.#accepted = true;
    for (const data of this.#queued.splice(0)) this.send(data);
  }
}

/*
 * A thin adapter: it accepts sockets with the Hibernation API and turns their events into RelayRoom
 * calls. Every socket is tagged with its role, room, and session, and the control socket stores
 * whether it holds the room. On wake the RelayRoom in memory is gone, so it is rebuilt from those
 * tags (see RelayRoom.restore): joined pairs carry on and half-open sessions are closed.
 */
export class RoomObject extends DurableObject<Env> {
  #room: RelayRoom | null = null;
  readonly #pipes = new WeakMap<WebSocket, SocketPipe>();

  override async fetch(request: Request): Promise<Response> {
    const role = request.headers.get(ROLE_HEADER);
    const roomId = request.headers.get(ROOM_HEADER);
    const session = role === "phone" ? newSessionId() : request.headers.get(SESSION_HEADER);
    if (!isWebSocketUpgrade(request) || !roomId || !isRole(role) || (role !== "control" && !session)) {
      return new Response("Not found", { status: 404 });
    }
    const room = this.#roomFor(roomId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // The room decides before the socket is accepted.
    const pipe = new SocketPipe(server, false);
    this.#pipes.set(server, pipe);
    if (role === "phone" && session) {
      room.phoneConnected(pipe, request.headers.get(CLIENT_HEADER) ?? "unknown", session);
    } else if (role === "host" && session) {
      room.sessionHostConnected(session, pipe);
    }

    if (pipe.closeRequest) {
      // A refused socket gets a plain accept and close. Closing a hibernatable socket whose client
      // has not sent anything yet leaves the client waiting in workerd, so it never learns why.
      server.accept();
      server.close(pipe.closeRequest.code, pipe.closeRequest.reason);
    } else {
      this.ctx.acceptWebSocket(
        server,
        session ? [role, `room:${roomId}`, `session:${session}`] : [role, `room:${roomId}`],
      );
      pipe.accepted();
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

  /** The pipe for a socket the runtime already accepted (the map is empty again after a wake). */
  #pipe(ws: WebSocket): SocketPipe {
    let pipe = this.#pipes.get(ws);
    if (!pipe) {
      pipe = new SocketPipe(ws, true);
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
