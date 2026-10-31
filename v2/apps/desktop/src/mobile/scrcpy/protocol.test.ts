import { describe, expect, it } from "vitest";

import {
  CODEC_H264,
  encodeBackOrScreenOn,
  encodeInjectKeycode,
  encodeInjectScroll,
  encodeInjectText,
  encodeInjectTouch,
  encodeRotateDevice,
  h264CodecString,
  KeyAction,
  MotionAction,
  ScrcpyVideoParser,
  scrcpyServerArgs,
  scrcpySocketName,
  type VideoEvent,
} from "./protocol.js";

const hex = (buffer: Buffer) => buffer.toString("hex");

// Vectors from scrcpy's app/tests/test_control_msg_serialize.c.
describe("scrcpy control messages", () => {
  it("encodes a keycode", () => {
    expect(hex(encodeInjectKeycode(KeyAction.up, 66, 5, 0x41))).toBe("0001" + "00000042" + "00000005" + "00000041");
  });

  it("encodes text", () => {
    expect(hex(encodeInjectText("hello, world!"))).toBe(`010000000d${Buffer.from("hello, world!").toString("hex")}`);
  });

  it("cuts long text at a character boundary", () => {
    const message = encodeInjectText("é".repeat(200));
    expect(message.readUInt32BE(1)).toBe(300);
    expect(message.length).toBe(305);
    const cut = encodeInjectText(`a${"é".repeat(200)}`);
    expect(cut.readUInt32BE(1)).toBe(299);
  });

  it("encodes a touch event", () => {
    const message = encodeInjectTouch({
      action: MotionAction.down,
      pointerId: 0x1234567887654321n,
      position: { x: 100, y: 200, width: 1080, height: 1920 },
      pressure: 1,
      actionButton: 1,
      buttons: 1,
    });
    expect(hex(message)).toBe(
      "0200" + "1234567887654321" + "00000064000000c8" + "04380780" + "ffff" + "00000001" + "00000001",
    );
    expect(message.length).toBe(32);
  });

  it("encodes negative pointer ids as two's complement", () => {
    const message = encodeInjectTouch({
      action: MotionAction.up,
      pointerId: -2n,
      position: { x: 0, y: 0, width: 1, height: 1 },
      pressure: 0,
      actionButton: 0,
      buttons: 0,
    });
    expect(hex(message.subarray(2, 10))).toBe("fffffffffffffffe");
  });

  it("encodes a scroll event with clamped fixed-point amounts", () => {
    const message = encodeInjectScroll({
      position: { x: 260, y: 1026, width: 1080, height: 1920 },
      hscroll: 16,
      vscroll: -16,
      buttons: 1,
    });
    expect(hex(message)).toBe("03" + "0000010400000402" + "04380780" + "7fff" + "8000" + "00000001");
  });

  it("encodes back-or-screen-on and rotate", () => {
    expect(hex(encodeBackOrScreenOn(KeyAction.up))).toBe("0401");
    expect(hex(encodeRotateDevice())).toBe("0b");
  });
});

describe("scrcpy server launch", () => {
  it("names the socket and passes only shell-safe tokens", () => {
    expect(scrcpySocketName(0x1234abcd)).toBe("scrcpy_1234abcd");
    const args = scrcpyServerArgs(0x42);
    expect(args).toContain("scid=00000042");
    expect(args).toContain("tunnel_forward=true");
    expect(args).toContain("audio=false");
    expect(args.slice(0, 5)).toEqual([
      "CLASSPATH=/data/local/tmp/zli-scrcpy-server.jar",
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      "5.0.1",
    ]);
    for (const arg of args) expect(arg).toMatch(/^[A-Za-z0-9_=./-]+$/u);
  });
});

function header(ptsFlags: bigint, size: number): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.writeBigUInt64BE(ptsFlags, 0);
  buffer.writeUInt32BE(size, 8);
  return buffer;
}

function sessionHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt8(0x80, 0);
  buffer.writeUInt32BE(width, 4);
  buffer.writeUInt32BE(height, 8);
  return buffer;
}

describe("scrcpy video stream", () => {
  const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xaa]);
  const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce]);
  const frame = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
  const name = Buffer.alloc(64);
  name.write("Pixel 7");
  const codec = Buffer.alloc(4);
  codec.writeUInt32BE(CODEC_H264);
  const stream = Buffer.concat([
    Buffer.from([0]),
    name,
    codec,
    sessionHeader(1080, 2400),
    header(1n << 62n, sps.length + pps.length),
    sps,
    pps,
    header((1n << 61n) | 33_333n, frame.length),
    frame,
  ]);

  it("reads the dummy byte, device name, codec, session, and merges config into the next frame", () => {
    const events = new ScrcpyVideoParser().push(stream);
    expect(events.map((event) => event.type)).toEqual(["device", "codec", "session", "frame"]);
    expect(events[0]).toEqual({ type: "device", name: "Pixel 7" });
    expect(events[2]).toEqual({ type: "session", width: 1080, height: 2400, clientResized: false });
    const frameEvent = events[3] as Extract<VideoEvent, { type: "frame" }>;
    expect(frameEvent.key).toBe(true);
    expect(frameEvent.pts).toBe(33_333n);
    expect(frameEvent.data).toEqual(Buffer.concat([sps, pps, frame]));
    expect(h264CodecString(frameEvent.config as Buffer)).toBe("avc1.42c01f");
  });

  it("gives the same events when the bytes arrive one at a time", () => {
    const parser = new ScrcpyVideoParser();
    const events: VideoEvent[] = [];
    for (const byte of stream) events.push(...parser.push(Buffer.from([byte])));
    expect(events.map((event) => event.type)).toEqual(["device", "codec", "session", "frame"]);
    expect((events[3] as Extract<VideoEvent, { type: "frame" }>).data).toEqual(Buffer.concat([sps, pps, frame]));
  });

  it("reports a device-side encoder failure", () => {
    const failed = Buffer.concat([Buffer.from([0]), name, Buffer.from([0, 0, 0, 1])]);
    expect(() => new ScrcpyVideoParser().push(failed)).toThrow(/could not configure/u);
  });
});
