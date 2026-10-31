import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { FakeProcessRunner } from "../FakeProcessRunner.js";
import { CODEC_H264, SCRCPY_SERVER_DEVICE_PATH, type VideoEvent } from "./protocol.js";
import { ScrcpySession, type ScrcpySocket } from "./ScrcpySession.js";

class FakeSocket extends EventEmitter implements ScrcpySocket {
  readonly written: Buffer[] = [];
  destroyed = false;

  write(data: Buffer): boolean {
    this.written.push(data);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function videoPreamble(): Buffer {
  const name = Buffer.alloc(64);
  name.write("Pixel 7");
  const codec = Buffer.alloc(4);
  codec.writeUInt32BE(CODEC_H264);
  const session = Buffer.alloc(12);
  session.writeUInt8(0x80, 0);
  session.writeUInt32BE(720, 4);
  session.writeUInt32BE(1600, 8);
  return Buffer.concat([Buffer.from([0]), name, codec, session]);
}

function setup() {
  const runner = new FakeProcessRunner((_command, args) =>
    args[2] === "forward" && args[3] === "tcp:0" ? { stdout: "27183\n" } : undefined,
  );
  const sockets: FakeSocket[] = [];
  const events: VideoEvent[] = [];
  const closes: string[] = [];
  const connect = (port: number) => {
    expect(port).toBe(27183);
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => {
      // The first connection is the one adb accepts before the server listens, so it drops at once.
      if (sockets.length === 1) socket.emit("close");
      else if (sockets.length === 2) socket.emit("data", videoPreamble());
    });
    return socket;
  };
  const start = () =>
    ScrcpySession.start({
      runner,
      adb: "/sdk/platform-tools/adb",
      serial: "emulator-5554",
      env: {},
      serverPath: "/zli/scrcpy-server",
      scid: 0x1234,
      connect,
      sleep: async () => undefined,
      onVideo: (event) => events.push(event),
      onClose: (reason) => closes.push(reason),
    });
  return { runner, sockets, events, closes, start };
}

describe("scrcpy session", () => {
  it("pushes the server, opens a tunnel, retries the dropped first connection, and reads video", async () => {
    const { runner, sockets, events, start } = setup();
    const session = await start();
    expect(runner.argsOf("adb").slice(0, 2)).toEqual([
      ["-s", "emulator-5554", "push", "/zli/scrcpy-server", SCRCPY_SERVER_DEVICE_PATH],
      ["-s", "emulator-5554", "forward", "tcp:0", "localabstract:scrcpy_00001234"],
    ]);
    expect(runner.spawned[0]?.args.slice(0, 3)).toEqual(["-s", "emulator-5554", "shell"]);
    expect(sockets).toHaveLength(3);
    expect(sockets[0]?.destroyed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["device", "codec", "session"]);
    expect(events[2]).toMatchObject({ width: 720, height: 1600 });
    expect(session.send(Buffer.from([1, 2]))).toBe(true);
    expect(sockets[2]?.written).toEqual([Buffer.from([1, 2])]);
  });

  it("removes the tunnel and stops the server when closed", async () => {
    const { runner, sockets, closes, start } = setup();
    const session = await start();
    await session.close("The panel stopped showing this device.");
    expect(session.closed).toBe(true);
    expect(session.send(Buffer.from([1]))).toBe(false);
    expect(runner.spawned[0]?.killed).toBe(true);
    expect(sockets[1]?.destroyed).toBe(true);
    expect(sockets[2]?.destroyed).toBe(true);
    expect(runner.argsOf("adb").at(-1)).toEqual(["-s", "emulator-5554", "forward", "--remove", "tcp:27183"]);
    expect(closes).toEqual(["The panel stopped showing this device."]);
  });

  it("ends the session with the server's output when the server exits", async () => {
    const { runner, closes, start } = setup();
    await start();
    runner.spawned[0]?.emit("ERROR: Could not open video stream\n", "stderr");
    runner.spawned[0]?.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closes).toEqual(["The scrcpy server stopped: ERROR: Could not open video stream"]);
  });
});
