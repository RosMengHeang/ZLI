import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RawData, WebSocketServer, WebSocket as WsSocket } from "ws";

import { MobileAccessStore, type SecretCodec } from "../apps/desktop/src/remote/MobileAccessStore.js";
import { MobileGateway, type PairingApprovalRequest } from "../apps/desktop/src/remote/MobileGateway.js";
import { PairingWindow } from "../apps/desktop/src/remote/PairingWindow.js";
import { RelayHost, type RelayState } from "../apps/desktop/src/remote/RelayHost.js";
import { raceRoutes } from "../apps/mobile/src/lib/routes.js";
import { DEFAULT_LIMITS, newSessionId, type PipeSocket, RelayRoom } from "../apps/relay/src/RelayRoom.js";
import { parseRoute } from "../apps/relay/src/routes.js";
import {
  type CreateWebSocket,
  fromBase64Url,
  generateKeyPair,
  type KeyPair,
  openRemoteSession,
  type RelayRoute,
  RemoteCloseCode,
  type RemoteConnectError,
  type RemoteSession,
  relayUrl,
  remoteUrl,
  roomIdFromSecret,
  webCryptoRandomBytes as random,
  toBase64Url,
  type WebSocketLike,
} from "../packages/remote-protocol/src/index.js";

/*
 * The whole remote path in one process: a phone (openRemoteSession), a relay (the real RelayRoom behind a local ws
 * server), and a desktop (the real RelayHost and MobileGateway) in front of a stand-in runtime. The relay can be made
 * hostile per test, to show that tampering, replays, and misrouting fail closed.
 *
 * RelayRoute only takes wss:// URLs. Rather than run TLS here, the phone and the desktop dial through createSocket
 * functions that rewrite RELAY_URL to the harness's ws://127.0.0.1 address. Everything after the URL is the same.
 */

const RELAY_URL = "wss://relay.test";
const RUNTIME_TOKEN = "runtime-token-never-on-the-relay";
const TERMINAL_OFF = "Terminal input from outside your network is turned off on the desktop.";
const PHONE_TIMEOUT_MS = 3_000;

const environmentId = "00000000-0000-4000-8000-000000000001";
const projectId = "40000000-0000-4000-8000-000000000001";
const worktreeId = "50000000-0000-4000-8000-000000000001";
const threadId = "60000000-0000-4000-8000-000000000001";
const terminalId = "70000000-0000-4000-8000-000000000001";
/** Starts with a letter, so a test can flip its case and still have a valid id. */
const commandId = "a0000000-0000-4000-8000-000000000001";
const otherCommandId = "a0000000-0000-4000-8000-000000000002";

const plainCodec: SecretCodec = {
  seal: (secret) => toBase64Url(secret),
  open: (sealed) => fromBase64Url(sealed),
};

type Frame = string | ArrayBuffer;
/** "up" is phone to desktop, "down" is desktop to phone. */
type Direction = "up" | "down";
type RelayedFrame = { direction: Direction; room: string; session: string; index: number; data: Frame };
/** What a hostile relay forwards in place of a frame: the frame, a changed copy, several copies, or nothing. */
type Tamper = (frame: RelayedFrame) => Frame[];

function toFrame(raw: RawData, isBinary: boolean): Frame {
  const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return isBinary ? new Uint8Array(bytes).buffer : bytes.toString("utf8");
}

function frameBuffer(frame: Frame): Buffer {
  return typeof frame === "string" ? Buffer.from(frame, "utf8") : Buffer.from(new Uint8Array(frame));
}

/**
 * A local relay: one real RelayRoom per room id behind a ws server, with the Worker's three paths. A phone passes its
 * rate-limit key as ?client=, standing in for the hash of its address the Worker would add.
 */
async function relayHarness() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const rooms = new Map<string, RelayRoom>();
  const controls = new Map<string, Set<PipeSocket>>();
  const sessions: Array<{ room: string; session: string }> = [];
  /** Close codes the desktop sent on its session sockets. The relay hands the phone a plain 1000 instead. */
  const desktopCloses: Array<{ session: string; code: number }> = [];
  /** Every byte the relay received, on every socket. */
  const captured: Buffer[] = [];
  const hostile: {
    tamper?: Tamper | undefined;
    /** Sends a phone into another room than the one it asked for. */
    phoneRoom?: ((room: string) => string) | undefined;
    /** Takes phone sockets itself, as a relay pretending to be the desktop would. */
    impostor?: ((socket: WsSocket) => void) | undefined;
    /** Swallows what the room tells the desktop, like a desktop that is asleep with its socket still open. */
    asleep?: boolean | undefined;
  } = {};

  const roomFor = (id: string) => {
    let room = rooms.get(id);
    if (!room) {
      room = new RelayRoom(id, { ...DEFAULT_LIMITS, dialTimeoutMs: 2_000 });
      rooms.set(id, room);
    }
    return room;
  };
  const pipe = (socket: WsSocket, control = false): PipeSocket => ({
    send(data) {
      if (control && hostile.asleep) return;
      if (socket.readyState === WsSocket.OPEN) socket.send(data);
    },
    close(code, reason) {
      try {
        socket.close(code, reason);
      } catch {
        socket.terminate();
      }
    },
  });

  server.on("connection", (socket, request) => {
    socket.on("error", () => undefined);
    const url = new URL(request.url ?? "/", "http://relay");
    const route = parseRoute(url.pathname);
    if (!route) {
      socket.close(1008);
      return;
    }
    socket.on("message", (raw, isBinary) => captured.push(frameBuffer(toFrame(raw, isBinary))));
    if (route.role === "control") {
      const room = roomFor(route.room);
      const control = pipe(socket, true);
      const set = controls.get(route.room) ?? new Set();
      set.add(control);
      controls.set(route.room, set);
      room.controlConnected(control);
      socket.on("message", (raw, isBinary) => room.hostControl(control, toFrame(raw, isBinary)));
      socket.on("close", () => room.hostControlClosed(control));
      return;
    }
    if (route.role === "phone" && hostile.impostor) {
      hostile.impostor(socket);
      return;
    }
    const roomId = route.role === "phone" ? (hostile.phoneRoom?.(route.room) ?? route.room) : route.room;
    const room = roomFor(roomId);
    const side = pipe(socket);
    const session = route.role === "phone" ? newSessionId() : (route.session ?? "");
    const direction: Direction = route.role === "phone" ? "up" : "down";
    let index = 0;
    socket.on("message", (raw, isBinary) => {
      const data = toFrame(raw, isBinary);
      const frames = hostile.tamper?.({ direction, room: roomId, session, index, data }) ?? [data];
      index += 1;
      for (const frame of frames) room.onFrame(route.role === "phone" ? "phone" : "host", session, frame, side);
    });
    if (route.role === "phone") {
      sessions.push({ room: roomId, session });
      room.phoneConnected(side, url.searchParams.get("client") ?? "unknown", session);
      socket.on("close", () => room.onClose("phone", session, side));
    } else {
      room.sessionHostConnected(session, side);
      socket.on("close", (code) => {
        desktopCloses.push({ session, code });
        room.onClose("host", session, side);
      });
    }
  });

  return {
    hostile,
    captured,
    desktopCloses,
    /** Points a relay URL at this harness. */
    local: (url: string) => (url.startsWith(RELAY_URL) ? `ws://127.0.0.1:${port}${url.slice(RELAY_URL.length)}` : url),
    hostOnline: (room: string) => [...(controls.get(room) ?? [])].some((control) => rooms.get(room)?.isHost(control)),
    /** Sessions the room still keeps, joined or waiting for the desktop. */
    heldSessions: (room: string) =>
      sessions.filter((entry) => entry.room === room && rooms.get(room)?.handshakeState(entry.session) !== undefined)
        .length,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

type Relay = Awaited<ReturnType<typeof relayHarness>>;

/** A stand-in for the loopback runtime: answers hello and commands, and records what reaches it. */
async function fakeRuntime() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const received: Array<{ type: string; token?: string; request?: { commandId: string; command: unknown } }> = [];
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as (typeof received)[number];
      received.push(message);
      if (message.type === "hello") {
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: 1,
            environment: { environmentId, label: "Local", protocolVersion: 1, capabilities: {} },
          }),
        );
      } else if (message.type === "command" && message.request) {
        socket.send(
          JSON.stringify({ type: "response", response: { commandId: message.request.commandId, accepted: true } }),
        );
      }
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    received,
    connections: () => connections,
    commands: () => received.filter((message) => message.type === "command"),
    /** Forgets what a LAN pairing brought, so a test sees only its own relay traffic. */
    reset: () => {
      received.length = 0;
      connections = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

/** A desktop: the store, the gateway in front of a fake runtime, and a RelayHost holding its room on the relay. */
async function startDesktop(relay: Relay) {
  const directory = await mkdtemp(join(tmpdir(), "zli-relay-e2e-"));
  const runtime = await fakeRuntime();
  const store = new MobileAccessStore(join(directory, "mobile.json"), plainCodec, random);
  await store.load();
  await store.setRelayEnabled(true);
  const secret = store.relaySecret();
  if (!secret) throw new Error("The store made no relay secret.");
  const route: RelayRoute = { url: RELAY_URL, room: roomIdFromSecret(secret) };
  const pairing = new PairingWindow(random);
  const logs: Array<{ message: string; detail?: Record<string, unknown> | undefined }> = [];
  const desk = {
    route,
    store,
    pairing,
    runtime,
    logs,
    publicKey: (await store.keyPair()).publicKey,
    port: 0,
    states: [] as RelayState[],
    approve: (_request: PairingApprovalRequest): Promise<boolean> => Promise.resolve(true),
    gateway: undefined as unknown as MobileGateway,
    host: undefined as unknown as RelayHost,
    async stop() {
      desk.host.stop();
      await desk.gateway.stop();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  desk.gateway = new MobileGateway({
    store,
    pairing,
    random,
    upstream: async () => ({ url: runtime.url, token: RUNTIME_TOKEN, environmentId }),
    projection: () => ({
      projects: [{ projectId: projectId as never, path: "/work/app", name: "app" }],
      worktrees: [
        {
          worktreeId: worktreeId as never,
          projectId: projectId as never,
          path: "/work/app-worktrees/fix",
          branch: "fix",
          status: "ready",
        },
      ],
      reviews: [],
    }),
    desktopName: () => "Test desk",
    hosts: () => ["127.0.0.1"],
    onChange: () => undefined,
    approvePairing: (request) => desk.approve(request),
    log: (message, detail) => logs.push({ message, detail }),
  });
  desk.port = await desk.gateway.start({ port: 0, host: "127.0.0.1" });
  desk.host = new RelayHost({
    route,
    secret,
    gateway: desk.gateway,
    createSocket: (url, options) => new WsSocket(relay.local(url), options),
    onState: (state) => desk.states.push(state),
  });
  desk.host.start();
  await until(() => relay.hostOnline(route.room));
  return desk;
}

type Desktop = Awaited<ReturnType<typeof startDesktop>>;
type Paired = { phone: KeyPair; deviceId: string; credential: string };

/** Fails the test instead of letting it hang when a session that should end stays open. */
function within<T>(promise: Promise<T>, what: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}.`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

function failure(promise: Promise<RemoteSession>): Promise<string> {
  return promise.then(
    (session) => {
      session.transport.close();
      return "connected";
    },
    (error: RemoteConnectError) => error.failure,
  );
}

function nextMessage(session: RemoteSession, type: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const off = session.transport.onMessage((message) => {
      if ((message as { type?: unknown }).type !== type) return;
      off();
      resolve(message as Record<string, unknown>);
    });
  });
}

function closed(session: RemoteSession) {
  return new Promise<string>((resolve) => session.transport.onClose(({ failure }) => resolve(failure)));
}

function command(id: string, text: string) {
  return {
    type: "command",
    request: { protocolVersion: 1, commandId: id, command: { type: "thread.send", threadId, text } },
  };
}

function terminalWrite(id: string) {
  return {
    type: "command",
    request: { protocolVersion: 1, commandId: id, command: { type: "terminal.write", terminalId, data: "ls\r" } },
  };
}

/** Flips one bit (0x20, a letter's case) in a frame, at a byte offset of its text or of its sealed plaintext. */
function flipBit(frame: Frame, offset: number): Frame {
  const bytes = new Uint8Array(frameBuffer(frame));
  // A sealed frame is an 8-byte counter, then the ChaCha20 ciphertext, which lines up byte for byte with the plaintext.
  const at = typeof frame === "string" ? offset : 8 + offset;
  bytes[at] = (bytes[at] ?? 0) ^ 0x20;
  return typeof frame === "string" ? Buffer.from(bytes).toString("utf8") : bytes.buffer;
}

/** The first letter of the proof in a hello or welcome. Its case flipped, it is still valid base64url. */
function proofLetter(text: string): number {
  const start = text.indexOf('"proof":"') + '"proof":"'.length;
  for (let index = start; index < start + 42; index += 1) if (/[A-Za-z]/u.test(text[index] ?? "")) return index;
  throw new Error("The proof has no letter.");
}

describe("remote access through the relay", () => {
  let relay: Relay;
  let desktops: Desktop[];

  async function desktop() {
    const desk = await startDesktop(relay);
    desktops.push(desk);
    return desk;
  }

  /** A phone socket. Relay URLs go to the harness, tagged with the phone's rate-limit key. */
  function phoneSocket(client = "phone-a"): CreateWebSocket {
    return (url) => {
      const local = relay.local(url);
      const tagged = local === url ? url : `${local}?client=${encodeURIComponent(client)}`;
      return new WebSocket(tagged) as unknown as WebSocketLike;
    };
  }

  function pair(desk: Desktop, url: string, phone = generateKeyPair(random), onWaiting?: () => void) {
    const pending = desk.pairing.open();
    return openRemoteSession({
      url,
      serverPublicKey: desk.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId: pending.pairingId, pairingSecret: pending.secret, deviceName: "Pixel 9" },
      random,
      createSocket: phoneSocket(),
      timeoutMs: PHONE_TIMEOUT_MS,
      ...(onWaiting ? { onWaiting } : {}),
    });
  }

  function resume(desk: Desktop, paired: Paired, url = relayUrl(desk.route, "phone"), client = "phone-a") {
    return openRemoteSession({
      url,
      serverPublicKey: desk.publicKey,
      clientStatic: paired.phone,
      target: { mode: "resume", deviceId: paired.deviceId, credential: fromBase64Url(paired.credential) },
      random,
      createSocket: phoneSocket(client),
      timeoutMs: PHONE_TIMEOUT_MS,
    });
  }

  /** Pairs on the LAN, as a phone does at home, so the relay sees only the resumes that follow. */
  async function pairedPhone(desk: Desktop): Promise<Paired> {
    const phone = generateKeyPair(random);
    const session = await pair(desk, remoteUrl("127.0.0.1", desk.port), phone);
    session.transport.close();
    const { deviceId = "", credential = "" } = session.paired ?? {};
    await until(() => desk.gateway.connectedDeviceIds().size === 0);
    desk.runtime.reset();
    return { phone, deviceId, credential };
  }

  beforeEach(async () => {
    relay = await relayHarness();
    desktops = [];
  });

  afterEach(async () => {
    for (const desk of desktops) await desk.stop();
    await relay.close();
  });

  it("pairs with the desktop's approval, then resumes and runs a runtime command through the relay", async () => {
    const desk = await desktop();
    const asked: PairingApprovalRequest[] = [];
    desk.approve = async (request) => {
      asked.push(request);
      return true;
    };
    const phone = generateKeyPair(random);
    let waited = false;
    const pairing = await pair(desk, relayUrl(desk.route, "phone"), phone, () => {
      waited = true;
    });
    expect(waited).toBe(true);
    expect(asked).toMatchObject([{ deviceName: "Pixel 9", route: "relay" }]);
    const { deviceId = "", credential = "" } = pairing.paired ?? {};
    expect(desk.store.devices().map((device) => device.deviceId)).toEqual([deviceId]);
    pairing.transport.close();

    const session = await resume(desk, { phone, deviceId, credential });
    expect(session.ready).toMatchObject({ type: "gateway.ready", desktopName: "Test desk", environmentId });
    const reply = nextMessage(session, "response");
    session.transport.send(command(commandId, "hi"));
    expect(await reply).toMatchObject({ response: { commandId, accepted: true } });
    expect(desk.runtime.commands()).toHaveLength(1);
    expect(desk.runtime.received.find((message) => message.type === "hello")?.token).toBe(RUNTIME_TOKEN);
    session.transport.close();
  });

  it("refuses a pairing the person at the desktop did not allow, and stores no phone", async () => {
    const desk = await desktop();
    desk.approve = async () => false;
    expect(await failure(pair(desk, relayUrl(desk.route, "phone")))).toBe("pairing-denied");
    expect(desk.store.devices()).toEqual([]);
    await until(() => relay.desktopCloses.some(({ code }) => code === RemoteCloseCode.pairingDenied));
    expect(desk.runtime.connections()).toBe(0);
  });

  describe("a relay that flips one bit", () => {
    const marker = "flip-target";
    const cases: Array<{
      name: string;
      direction: Direction;
      index: number;
      offset: (frame: Frame) => number;
      /** Where the session breaks: while connecting, or once it is open and a command is sent. */
      stage: "connect" | "open";
      phoneFailure?: string;
      desktopCode?: number;
    }> = [
      {
        name: "the phone's hello",
        direction: "up",
        index: 0,
        offset: (frame) => proofLetter(String(frame)),
        stage: "connect",
        desktopCode: RemoteCloseCode.handshake,
      },
      {
        name: "the phone's sealed credential",
        // Inside the type, `"gateway.auth"`.
        direction: "up",
        index: 1,
        offset: () => '{"type":"'.length,
        stage: "connect",
        desktopCode: RemoteCloseCode.protocol,
      },
      {
        name: "a sealed command from the phone",
        direction: "up",
        index: 2,
        offset: () => JSON.stringify(command(commandId, marker)).indexOf(marker),
        stage: "open",
        desktopCode: RemoteCloseCode.protocol,
      },
      {
        name: "the desktop's welcome",
        direction: "down",
        index: 0,
        offset: (frame) => proofLetter(String(frame)),
        stage: "connect",
        phoneFailure: "handshake",
      },
      {
        name: "the desktop's sealed ready message",
        // The first letter of the desktop name.
        direction: "down",
        index: 1,
        offset: () => '{"type":"gateway.ready","desktopName":"'.length,
        stage: "connect",
        phoneFailure: "protocol",
      },
      {
        name: "a sealed runtime reply",
        // The first letter of the command id.
        direction: "down",
        index: 2,
        offset: () => '{"type":"response","response":{"commandId":"'.length,
        stage: "open",
        phoneFailure: "protocol",
      },
    ];

    for (const flip of cases) {
      it(`fails closed when it flips ${flip.name}`, async () => {
        const desk = await desktop();
        const paired = await pairedPhone(desk);
        let flipped = false;
        relay.hostile.tamper = (frame) => {
          if (frame.direction !== flip.direction || frame.index !== flip.index) return [frame.data];
          flipped = true;
          return [flipBit(frame.data, flip.offset(frame.data))];
        };

        if (flip.stage === "connect") {
          const outcome = await failure(resume(desk, paired));
          expect(outcome).not.toBe("connected");
          if (flip.phoneFailure) expect(outcome).toBe(flip.phoneFailure);
        } else {
          const session = await resume(desk, paired);
          const gone = closed(session);
          const replies: unknown[] = [];
          session.transport.onMessage((message) => replies.push(message));
          session.transport.send(command(commandId, marker));
          const outcome = await within(gone, "the session to close");
          if (flip.phoneFailure) expect(outcome).toBe(flip.phoneFailure);
          expect(replies).toEqual([]);
        }
        expect(flipped).toBe(true);
        if (flip.desktopCode !== undefined) {
          const code = flip.desktopCode;
          await until(() => relay.desktopCloses.some((entry) => entry.code === code));
        }
        await until(() => desk.gateway.connectedDeviceIds().size === 0);

        // A flip upstream of the command means the command never reached the runtime; a flip in the reply means the
        // runtime got the untouched command and the phone dropped the session rather than read a changed answer.
        const expected = flip.direction === "down" && flip.stage === "open" ? 1 : 0;
        expect(desk.runtime.commands()).toHaveLength(expected);
        // Before the credential is checked, the desktop opens no runtime connection at all.
        if (flip.index === 0 || (flip.direction === "up" && flip.index === 1)) {
          expect(desk.runtime.connections()).toBe(0);
        }
      });
    }
  });

  it("refuses a sealed frame the relay plays twice within a session", async () => {
    const desk = await desktop();
    const paired = await pairedPhone(desk);
    relay.hostile.tamper = (frame) =>
      frame.direction === "up" && frame.index === 2 ? [frame.data, frame.data] : [frame.data];
    const session = await resume(desk, paired);
    const gone = closed(session);
    session.transport.send(command(commandId, "once"));
    await within(gone, "the session to close");
    await until(() => relay.desktopCloses.some(({ code }) => code === RemoteCloseCode.protocol));
    expect(desk.runtime.commands()).toHaveLength(1);
  });

  it("does not let a captured handshake open a new session", async () => {
    const desk = await desktop();
    const paired = await pairedPhone(desk);
    const sent: Frame[] = [];
    const welcomes: string[] = [];
    relay.hostile.tamper = (frame) => {
      if (frame.direction === "up") sent.push(frame.data);
      else if (frame.index === 0) welcomes.push(String(frame.data));
      return [frame.data];
    };
    const original = await resume(desk, paired);
    original.transport.close();
    await until(() => desk.gateway.connectedDeviceIds().size === 0);
    relay.hostile.tamper = undefined;
    const runtimeConnections = desk.runtime.connections();
    const [hello, credential] = sent;
    expect(typeof hello).toBe("string");
    expect(credential).toBeInstanceOf(ArrayBuffer);

    // The relay plays the phone's hello and sealed credential back in a session of its own.
    const attacker = new WebSocket(`${relay.local(relayUrl(desk.route, "phone"))}?client=attacker`);
    attacker.binaryType = "arraybuffer";
    const received: unknown[] = [];
    const firstReply = new Promise<void>((resolve) => {
      attacker.onmessage = (event) => {
        received.push(event.data);
        resolve();
      };
    });
    const attackerClosed = new Promise<void>((resolve) => {
      attacker.onclose = () => resolve();
    });
    await new Promise<void>((resolve) => {
      attacker.onopen = () => resolve();
    });
    attacker.send(hello as string);
    await within(firstReply, "the desktop's welcome");
    attacker.send(credential as ArrayBuffer);
    await within(attackerClosed, "the replayed session to close");

    // The desktop answers a replayed hello with a fresh key, so the old sealed credential no longer opens.
    expect(received).toHaveLength(1);
    const welcome = JSON.parse(String(received[0])) as { type: string; serverEphemeral: string };
    expect(welcome.type).toBe("welcome");
    expect(welcome.serverEphemeral).not.toBe(
      (JSON.parse(welcomes[0] ?? "{}") as { serverEphemeral?: string }).serverEphemeral,
    );
    expect(relay.desktopCloses.at(-1)?.code).toBe(RemoteCloseCode.protocol);
    expect(desk.runtime.connections()).toBe(runtimeConnections);
    expect(desk.gateway.connectedDeviceIds().size).toBe(0);
  });

  it("fails when the relay routes the phone to another desktop's room", async () => {
    const home = await desktop();
    const other = await desktop();
    const paired = await pairedPhone(home);
    // The other desktop even knows the phone: its id and key cross the relay in the clear, and the credential hash is
    // copied too, so only the desktop key the phone pinned at pairing tells the two apart.
    const record = home.store.device(paired.deviceId);
    if (!record) throw new Error("The phone was not stored.");
    await other.store.addDevice({ ...record });
    relay.hostile.phoneRoom = (room) => (room === home.route.room ? other.route.room : room);

    expect(await failure(resume(home, paired))).not.toBe("connected");
    await until(() => other.logs.some(({ message }) => message === "phone handshake failed"));
    expect(other.runtime.connections()).toBe(0);
    expect(home.runtime.connections()).toBe(0);
    expect(other.gateway.connectedDeviceIds().size).toBe(0);
  });

  it("fails on the pinned desktop key when the relay answers as the desktop", async () => {
    const desk = await desktop();
    const paired = await pairedPhone(desk);
    const impostorKey = generateKeyPair(random);
    relay.hostile.impostor = (socket) => {
      socket.once("message", () =>
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: 1,
            serverEphemeral: toBase64Url(impostorKey.publicKey),
            proof: toBase64Url(random(32)),
          }),
        ),
      );
    };
    expect(await failure(resume(desk, paired))).toBe("handshake");
    expect(desk.runtime.connections()).toBe(0);
  });

  it("carries no plaintext the relay could read", async () => {
    const desk = await desktop();
    const phone = generateKeyPair(random);
    const pairing = await pair(desk, relayUrl(desk.route, "phone"), phone);
    const { deviceId = "", credential = "" } = pairing.paired ?? {};
    pairing.transport.close();
    const session = await resume(desk, { phone, deviceId, credential });
    const marker = "secret-command-text-the-relay-must-not-see";
    const reply = nextMessage(session, "response");
    session.transport.send(command(commandId, marker));
    await reply;
    session.transport.close();
    expect(desk.runtime.commands()).toMatchObject([{ request: { command: { text: marker } } }]);

    const wire = Buffer.concat(relay.captured);
    expect(wire.includes(Buffer.from(marker))).toBe(false);
    expect(wire.includes(Buffer.from(credential))).toBe(false);
    expect(wire.includes(Buffer.from(fromBase64Url(credential)))).toBe(false);
    expect(wire.includes(Buffer.from(RUNTIME_TOKEN))).toBe(false);
    expect(wire.includes(Buffer.from("Test desk"))).toBe(false);
    expect(wire.includes(Buffer.from("Pixel 9"))).toBe(false);
    // The capture is real: the device id travels in the hello in the clear, by design.
    expect(wire.includes(Buffer.from(deviceId))).toBe(true);
  });

  it("refuses an unknown phone on the relay and counts it against that client's key only", async () => {
    const desk = await desktop();
    const paired = await pairedPhone(desk);
    const stranger = () => ({
      phone: generateKeyPair(random),
      deviceId: toBase64Url(random(16)),
      credential: toBase64Url(random(32)),
    });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect(await failure(resume(desk, stranger(), undefined, "stranger"))).not.toBe("connected");
      await until(() => relay.desktopCloses.length === attempt);
      expect(relay.desktopCloses.at(-1)?.code).toBe(RemoteCloseCode.notPaired);
    }
    expect(await failure(resume(desk, stranger(), undefined, "stranger"))).not.toBe("connected");
    await until(() => relay.desktopCloses.length === 21);
    expect(relay.desktopCloses.at(-1)?.code).toBe(RemoteCloseCode.rateLimited);
    expect(desk.logs).toContainEqual({
      message: "phone connection refused: too many attempts",
      detail: { route: "relay", client: "relay:stranger" },
    });

    // The paired phone comes through the same relay with its own key and is not held back.
    const session = await resume(desk, paired, undefined, "home");
    expect(session.ready.type).toBe("gateway.ready");
    session.transport.close();
  });

  it("closes a revoked phone's relay session within a second", async () => {
    const desk = await desktop();
    const paired = await pairedPhone(desk);
    const session = await resume(desk, paired);
    const gone = closed(session);
    const started = Date.now();
    await desk.store.removeDevice(paired.deviceId);
    desk.gateway.disconnect(paired.deviceId);
    await within(gone, "the revoked session to close", 1_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await failure(resume(desk, paired))).not.toBe("connected");
  });

  describe("with the desktop offline", () => {
    function raceRelay(desk: Desktop, paired: Paired) {
      return raceRoutes({
        lanHosts: [],
        port: desk.port,
        relay: desk.route,
        open: (url, signal) =>
          openRemoteSession({
            url,
            serverPublicKey: desk.publicKey,
            clientStatic: paired.phone,
            target: { mode: "resume", deviceId: paired.deviceId, credential: fromBase64Url(paired.credential) },
            random,
            createSocket: phoneSocket(),
            timeoutMs: 1_000,
            signal,
          }),
      }).then(
        () => "connected",
        (error: RemoteConnectError) => error.failure,
      );
    }

    async function offlineDesktop() {
      const desk = await desktop();
      const paired = await pairedPhone(desk);
      desk.host.stop();
      await until(() => !relay.hostOnline(desk.route.room));
      return { desk, paired };
    }

    it("fails promptly and leaves no session in the room", async () => {
      const { desk, paired } = await offlineDesktop();
      const started = Date.now();
      expect(await raceRelay(desk, paired)).not.toBe("connected");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(relay.heldSessions(desk.route.room)).toBe(0);
    });

    // TODO(bug): the relay refuses a phone for an offline desktop with 1013, which the phone reads as "unavailable"
    // ("ZLI on the desktop is still starting"). Review Focus 5 wants "PC unreachable", which the phone app only shows
    // for network and timeout failures. Remove `.fails` once the phone maps a relay 1013 to network.
    it.fails("reports the offline desktop as a network failure", async () => {
      const { desk, paired } = await offlineDesktop();
      expect(await raceRelay(desk, paired)).toBe("network");
    });

    it("gives up on a desktop that holds its room but no longer answers, and leaves no session", async () => {
      const desk = await desktop();
      const paired = await pairedPhone(desk);
      // Asleep with the socket still open: the room still counts it as the host, but nothing comes back.
      relay.hostile.asleep = true;
      const started = Date.now();
      expect(await raceRelay(desk, paired)).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_000);
      await until(() => relay.heldSessions(desk.route.room) === 0);
    });
  });

  it("refuses terminal input over the relay by default, and allows it on the LAN", async () => {
    const desk = await desktop();
    const paired = await pairedPhone(desk);
    const remote = await resume(desk, paired);
    const refused = nextMessage(remote, "response");
    remote.transport.send(terminalWrite(commandId));
    expect(await refused).toEqual({
      type: "response",
      response: {
        commandId,
        accepted: false,
        error: { code: "unauthorized", message: TERMINAL_OFF, retryable: false },
      },
    });
    remote.transport.close();
    expect(desk.runtime.commands()).toEqual([]);

    const local = await resume(desk, paired, remoteUrl("127.0.0.1", desk.port));
    const allowed = nextMessage(local, "response");
    local.transport.send(terminalWrite(otherCommandId));
    expect(await allowed).toMatchObject({ response: { commandId: otherCommandId, accepted: true } });
    local.transport.close();
    expect(desk.runtime.commands()).toMatchObject([{ request: { commandId: otherCommandId } }]);
  });
});
