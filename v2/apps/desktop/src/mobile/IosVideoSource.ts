import { MobileDriverError } from "./MobileDriver.js";
import type { ProcessRunner, RunningProcess } from "./ProcessRunner.js";
import type { VideoEvent } from "./scrcpy/protocol.js";

/** One decodable picture from an H.264 Annex B stream, in the shape scrcpy frames take. */
export type AnnexBUnit = { readonly key: boolean; readonly data: Buffer; readonly config?: Buffer };

const START_CODE = Buffer.from([0, 0, 0, 1]);
const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
/** A stream with no start code in this many bytes is not H.264, and holding more would only grow memory. */
const MAX_PENDING = 8 * 1024 * 1024;

/**
 * Splits a raw H.264 Annex B byte stream into access units, one per picture, as WebCodecs wants them.
 * Chunks may cut anywhere, even through a start code. A unit is complete once the first bytes of the next one
 * arrive, so each picture leaves when the next one starts. A new unit starts at an access unit delimiter, at SPS, PPS, or SEI after
 * a slice, and at a slice whose first_mb_in_slice is 0 after a slice.
 */
export class AnnexBFramer {
  #pending: Buffer = Buffer.alloc(0);
  #nals: Buffer[] = [];
  #hasSlice = false;

  push(chunk: Buffer): AnnexBUnit[] {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    const units: AnnexBUnit[] = [];
    const starts = startCodes(this.#pending);
    if (starts.length === 0) {
      if (this.#pending.length > MAX_PENDING) this.#pending = Buffer.alloc(0);
      return units;
    }
    for (let index = 0; index + 1 < starts.length; index += 1) {
      const start = starts[index];
      const next = starts[index + 1];
      if (!start || !next) continue;
      this.#nal(this.#pending.subarray(start.payload, next.at), units);
    }
    const last = starts.at(-1);
    if (!last) return units;
    // The unit before an unfinished NAL is complete as soon as that NAL's first bytes say it starts a new one.
    const header = this.#pending[last.payload];
    if (header !== undefined && this.#pending.length > last.payload + 1 && this.#hasSlice) {
      if (startsUnit(header, this.#pending[last.payload + 1] ?? 0)) {
        const unit = this.#take();
        if (unit) units.push(unit);
      }
    }
    this.#pending = Buffer.from(this.#pending.subarray(last.at));
    return units;
  }

  /** Ends the stream, returning the picture still held. */
  flush(): AnnexBUnit[] {
    const units: AnnexBUnit[] = [];
    const [start] = startCodes(this.#pending);
    if (start) this.#nal(this.#pending.subarray(start.payload), units);
    this.#pending = Buffer.alloc(0);
    const unit = this.#take();
    if (unit) units.push(unit);
    return units;
  }

  #nal(nal: Buffer, units: AnnexBUnit[]): void {
    const header = nal[0];
    if (header === undefined) return;
    const type = header & 0x1f;
    const slice = type === NAL_SLICE || type === NAL_IDR;
    if (this.#hasSlice && startsUnit(header, nal[1] ?? 0)) {
      const unit = this.#take();
      if (unit) units.push(unit);
    }
    this.#nals.push(Buffer.from(nal));
    if (slice) this.#hasSlice = true;
  }

  #take(): AnnexBUnit | undefined {
    const nals = this.#nals;
    const hadSlice = this.#hasSlice;
    this.#nals = [];
    this.#hasSlice = false;
    if (!hadSlice) return undefined;
    const types = nals.map((nal) => (nal[0] ?? 0) & 0x1f);
    const config = nals.filter((_nal, index) => types[index] === NAL_SPS || types[index] === NAL_PPS);
    return {
      key: types.includes(NAL_IDR),
      data: Buffer.concat(nals.flatMap((nal) => [START_CODE, nal])),
      ...(config.length > 0 ? { config: Buffer.concat(config.flatMap((nal) => [START_CODE, nal])) } : {}),
    };
  }
}

function startsUnit(header: number, next: number): boolean {
  const type = header & 0x1f;
  if (type === NAL_AUD || type === NAL_SPS || type === NAL_PPS || type === NAL_SEI) return true;
  // ue(v) codes 0 as a single 1 bit, so a slice header that starts with a set bit has first_mb_in_slice 0.
  return (type === NAL_SLICE || type === NAL_IDR) && (next & 0x80) !== 0;
}

/** Where each start code begins, and where the NAL unit after it begins. */
function startCodes(buffer: Buffer): { at: number; payload: number }[] {
  const found: { at: number; payload: number }[] = [];
  for (let index = 0; index + 2 < buffer.length; index += 1) {
    if (buffer[index] !== 0 || buffer[index + 1] !== 0) continue;
    if (buffer[index + 2] === 1) {
      const four = index > 0 && buffer[index - 1] === 0;
      found.push({ at: four ? index - 1 : index, payload: index + 3 });
      index += 2;
    }
  }
  return found;
}

export type IdbVideoSession = { close(reason?: string): Promise<void>; readonly closed: boolean };

export type IdbVideoOptions = {
  readonly runner: ProcessRunner;
  readonly idb: string;
  readonly udid: string;
  readonly fps?: number;
  readonly onVideo: (event: VideoEvent) => void;
  readonly onClose: (reason: string) => void;
  readonly now?: () => number;
};

/**
 * Runs `idb video-stream --format h264` and turns its stdout into the frame events scrcpy produces, so the
 * panel decodes iOS video the same way it decodes Android video. Off by default: see iosVideoEnabled.
 *
 * TODO: before turning this on for everyone, check on a Mac that idb writes the raw stream to stdout when no
 * output file is given, that the first unit carries SPS and PPS, and how the stream changes when the
 * simulator rotates. The frame size comes from a screenshot, so a rotation needs the stream restarted, or
 * the size read from the SPS, which this does not parse yet.
 */
export function startIdbVideo(options: IdbVideoOptions): IdbVideoSession {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const framer = new AnnexBFramer();
  let closed = false;
  let stderr = "";
  const child: RunningProcess = options.runner.spawn(options.idb, idbVideoArgs(options.udid, options.fps ?? 30));
  const emit = (units: readonly AnnexBUnit[]) => {
    for (const unit of units) {
      if (closed) return;
      const pts = BigInt(Math.max(0, Math.round((now() - startedAt) * 1000)));
      options.onVideo({
        type: "frame",
        key: unit.key,
        pts,
        data: unit.data,
        ...(unit.config ? { config: unit.config } : {}),
      });
    }
  };
  child.onStdout((chunk) => emit(framer.push(chunk)));
  child.onStderr((chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1_000);
  });
  void child.exited.then((code) => {
    if (closed) return;
    emit(framer.flush());
    closed = true;
    const detail = stderr.trim();
    options.onClose(
      `idb stopped streaming video${code === null ? "" : ` (exit code ${code})`}${detail ? `: ${detail}` : "."}`,
    );
  });
  return {
    get closed() {
      return closed;
    },
    async close() {
      if (closed) return;
      closed = true;
      child.kill();
      await child.exited;
    },
  };
}

export function idbVideoArgs(udid: string, fps: number): string[] {
  if (!/^[A-Za-z0-9-]+$/u.test(udid)) throw new MobileDriverError("This is not a simulator udid.");
  return ["video-stream", "--udid", udid, "--format", "h264", "--fps", String(fps)];
}

/** The idb video path stays off unless ZLI_MOBILE_IOS_VIDEO=1, until it has run on a Mac. */
export function iosVideoEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ZLI_MOBILE_IOS_VIDEO === "1";
}
