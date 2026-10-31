export const SCRCPY_VERSION = "5.0.1";
export const SCRCPY_SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
export const SCRCPY_SERVER_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
export const SCRCPY_SERVER_DEVICE_PATH = "/data/local/tmp/zli-scrcpy-server.jar";

export const CODEC_H264 = 0x68_32_36_34;
const CODEC_DISABLED = 0;
const CODEC_ERROR = 1;
const DEVICE_NAME_LENGTH = 64;
const HEADER_LENGTH = 12;
const FLAG_SESSION = 1n << 63n;
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = FLAG_KEY_FRAME - 1n;
const MAX_PACKET_BYTES = 16 * 1024 * 1024;

/** Control message types, numbered as in scrcpy's control_msg.h. */
export const ControlType = {
  injectKeycode: 0,
  injectText: 1,
  injectTouchEvent: 2,
  injectScrollEvent: 3,
  backOrScreenOn: 4,
  expandNotificationPanel: 5,
  expandSettingsPanel: 6,
  collapsePanels: 7,
  getClipboard: 8,
  setClipboard: 9,
  setDisplayPower: 10,
  rotateDevice: 11,
} as const;

/** Android MotionEvent and KeyEvent action codes. */
export const MotionAction = { down: 0, up: 1, move: 2 } as const;
export const KeyAction = { down: 0, up: 1 } as const;

/** scrcpy reserves these pointer ids: the mouse, and a finger with no id of its own. */
export const POINTER_ID_MOUSE = -1n;
export const POINTER_ID_GENERIC_FINGER = -2n;
export const BUTTON_PRIMARY = 1;
export const MAX_INJECT_TEXT_BYTES = 300;

export type ScreenPosition = { x: number; y: number; width: number; height: number };

export function encodeInjectKeycode(action: number, keycode: number, repeat = 0, metastate = 0): Buffer {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt8(ControlType.injectKeycode, 0);
  buffer.writeUInt8(action, 1);
  buffer.writeUInt32BE(keycode >>> 0, 2);
  buffer.writeUInt32BE(repeat >>> 0, 6);
  buffer.writeUInt32BE(metastate >>> 0, 10);
  return buffer;
}

/** Text longer than scrcpy's limit is cut at a character boundary, as the scrcpy client does. */
export function encodeInjectText(text: string): Buffer {
  let bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_INJECT_TEXT_BYTES) {
    let end = MAX_INJECT_TEXT_BYTES;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    bytes = bytes.subarray(0, end);
  }
  const buffer = Buffer.alloc(5 + bytes.length);
  buffer.writeUInt8(ControlType.injectText, 0);
  buffer.writeUInt32BE(bytes.length, 1);
  bytes.copy(buffer, 5);
  return buffer;
}

function writePosition(buffer: Buffer, offset: number, position: ScreenPosition): void {
  buffer.writeInt32BE(Math.round(position.x), offset);
  buffer.writeInt32BE(Math.round(position.y), offset + 4);
  buffer.writeUInt16BE(position.width & 0xffff, offset + 8);
  buffer.writeUInt16BE(position.height & 0xffff, offset + 10);
}

/** Pressure in [0, 1] as unsigned 16-bit fixed point, with 1.0 mapped to 0xffff. */
export function floatToU16FixedPoint(value: number): number {
  const scaled = Math.trunc(Math.min(1, Math.max(0, value)) * 0x1_0000);
  return Math.min(0xffff, scaled);
}

/** A value in [-1, 1] as signed 16-bit fixed point, clamped the way scrcpy clamps it. */
export function floatToI16FixedPoint(value: number): number {
  const scaled = Math.trunc(Math.min(1, Math.max(-1, value)) * 0x8000);
  return Math.min(0x7fff, Math.max(-0x8000, scaled));
}

export function encodeInjectTouch(input: {
  action: number;
  pointerId: bigint;
  position: ScreenPosition;
  pressure: number;
  actionButton: number;
  buttons: number;
}): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt8(ControlType.injectTouchEvent, 0);
  buffer.writeUInt8(input.action, 1);
  buffer.writeBigUInt64BE(BigInt.asUintN(64, input.pointerId), 2);
  writePosition(buffer, 10, input.position);
  buffer.writeUInt16BE(floatToU16FixedPoint(input.pressure), 22);
  buffer.writeUInt32BE(input.actionButton >>> 0, 24);
  buffer.writeUInt32BE(input.buttons >>> 0, 28);
  return buffer;
}

/** Scroll amounts are in [-16, 16] notches, normalized to [-1, 1] on the wire. */
export function encodeInjectScroll(input: {
  position: ScreenPosition;
  hscroll: number;
  vscroll: number;
  buttons: number;
}): Buffer {
  const buffer = Buffer.alloc(21);
  buffer.writeUInt8(ControlType.injectScrollEvent, 0);
  writePosition(buffer, 1, input.position);
  buffer.writeInt16BE(floatToI16FixedPoint(input.hscroll / 16), 13);
  buffer.writeInt16BE(floatToI16FixedPoint(input.vscroll / 16), 15);
  buffer.writeUInt32BE(input.buttons >>> 0, 17);
  return buffer;
}

export function encodeBackOrScreenOn(action: number): Buffer {
  return Buffer.from([ControlType.backOrScreenOn, action]);
}

export function encodeRotateDevice(): Buffer {
  return Buffer.from([ControlType.rotateDevice]);
}

/** A random 31-bit session id, written as eight hex digits in the socket name and server arguments. */
export function scrcpySocketName(scid: number): string {
  return `scrcpy_${scidHex(scid)}`;
}

export function scidHex(scid: number): string {
  return (scid & 0x7fff_ffff).toString(16).padStart(8, "0");
}

/**
 * The server command line. Every value is a plain token, because adb passes the line to the device's
 * shell unquoted.
 */
export function scrcpyServerArgs(
  scid: number,
  options: { maxSize?: number; maxFps?: number; bitRate?: number } = {},
): string[] {
  return [
    `CLASSPATH=${SCRCPY_SERVER_DEVICE_PATH}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    SCRCPY_VERSION,
    `scid=${scidHex(scid)}`,
    "log_level=info",
    "audio=false",
    "tunnel_forward=true",
    "video_codec=h264",
    `max_size=${options.maxSize ?? 1280}`,
    `max_fps=${options.maxFps ?? 30}`,
    `video_bit_rate=${options.bitRate ?? 4_000_000}`,
    "control=true",
    "cleanup=true",
    "power_off_on_close=false",
    "clipboard_autosync=false",
  ];
}

export type VideoEvent =
  | { type: "device"; name: string }
  | { type: "codec"; codecId: number }
  | { type: "session"; width: number; height: number; clientResized: boolean }
  /** A frame ready to decode. H.264 config packets (SPS and PPS) are merged into the frame that follows them. */
  | { type: "frame"; key: boolean; pts: bigint; data: Buffer; config?: Buffer };

/**
 * Reads the scrcpy video socket incrementally: the dummy byte and device name a forward tunnel sends first,
 * the codec id, then 12-byte headers that start either a session (new size) or a media packet.
 */
export class ScrcpyVideoParser {
  #buffer: Buffer = Buffer.alloc(0);
  #stage: "dummy" | "device" | "codec" | "packets";
  #pendingConfig: Buffer | undefined;
  #latestConfig: Buffer | undefined;
  readonly #deviceMeta: boolean;

  constructor(options: { dummyByte?: boolean; deviceMeta?: boolean } = {}) {
    this.#deviceMeta = options.deviceMeta !== false;
    this.#stage = options.dummyByte !== false ? "dummy" : this.#deviceMeta ? "device" : "codec";
  }

  /** The last SPS and PPS seen, which a decoder that joins late needs before any key frame. */
  get latestConfig(): Buffer | undefined {
    return this.#latestConfig;
  }

  push(chunk: Buffer): VideoEvent[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const events: VideoEvent[] = [];
    for (;;) {
      if (this.#stage === "dummy") {
        if (this.#buffer.length < 1) break;
        this.#buffer = this.#buffer.subarray(1);
        this.#stage = this.#deviceMeta ? "device" : "codec";
        continue;
      }
      if (this.#stage === "device") {
        if (this.#buffer.length < DEVICE_NAME_LENGTH) break;
        const raw = this.#buffer.subarray(0, DEVICE_NAME_LENGTH);
        const end = raw.indexOf(0);
        events.push({ type: "device", name: raw.subarray(0, end < 0 ? raw.length : end).toString("utf8") });
        this.#buffer = this.#buffer.subarray(DEVICE_NAME_LENGTH);
        this.#stage = "codec";
        continue;
      }
      if (this.#stage === "codec") {
        if (this.#buffer.length < 4) break;
        const codecId = this.#buffer.readUInt32BE(0);
        this.#buffer = this.#buffer.subarray(4);
        if (codecId === CODEC_DISABLED) throw new Error("The device disabled its video stream.");
        if (codecId === CODEC_ERROR) throw new Error("The device could not configure its video encoder.");
        if (codecId !== CODEC_H264) throw new Error(`The device sent an unexpected codec 0x${codecId.toString(16)}.`);
        events.push({ type: "codec", codecId });
        this.#stage = "packets";
        continue;
      }
      if (this.#buffer.length < HEADER_LENGTH) break;
      const ptsFlags = this.#buffer.readBigUInt64BE(0);
      if ((ptsFlags & FLAG_SESSION) !== 0n) {
        events.push({
          type: "session",
          width: this.#buffer.readUInt32BE(4),
          height: this.#buffer.readUInt32BE(8),
          clientResized: (this.#buffer.readUInt8(3) & 1) === 1,
        });
        this.#buffer = this.#buffer.subarray(HEADER_LENGTH);
        continue;
      }
      const size = this.#buffer.readUInt32BE(8);
      if (size === 0 || size > MAX_PACKET_BYTES) throw new Error(`The device sent an invalid packet size ${size}.`);
      if (this.#buffer.length < HEADER_LENGTH + size) break;
      const data = Buffer.from(this.#buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + size));
      this.#buffer = this.#buffer.subarray(HEADER_LENGTH + size);
      if ((ptsFlags & FLAG_CONFIG) !== 0n) {
        this.#pendingConfig = this.#pendingConfig ? Buffer.concat([this.#pendingConfig, data]) : data;
        this.#latestConfig = this.#pendingConfig;
        continue;
      }
      const config = this.#pendingConfig;
      this.#pendingConfig = undefined;
      events.push({
        type: "frame",
        key: (ptsFlags & FLAG_KEY_FRAME) !== 0n,
        pts: ptsFlags & PTS_MASK,
        data: config ? Buffer.concat([config, data]) : data,
        ...(config ? { config } : {}),
      });
    }
    return events;
  }
}

/** The WebCodecs codec string (avc1.PPCCLL) from the SPS in an Annex B config packet. */
export function h264CodecString(config: Buffer): string | undefined {
  for (let index = 0; index + 4 < config.length; index += 1) {
    const startCode3 = config[index] === 0 && config[index + 1] === 0 && config[index + 2] === 1;
    if (!startCode3) continue;
    const header = config[index + 3];
    if (header === undefined || (header & 0x1f) !== 7) continue;
    const profile = config[index + 4];
    const constraints = config[index + 5];
    const level = config[index + 6];
    if (profile === undefined || constraints === undefined || level === undefined) return undefined;
    return `avc1.${[profile, constraints, level].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return undefined;
}
