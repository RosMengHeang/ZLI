import { describe, expect, it } from "vitest";

import { FakeProcessRunner } from "./FakeProcessRunner.js";
import { AnnexBFramer, idbVideoArgs, iosVideoEnabled, startIdbVideo } from "./IosVideoSource.js";
import type { VideoEvent } from "./scrcpy/protocol.js";
import { h264CodecString } from "./scrcpy/protocol.js";

const four = [0, 0, 0, 1];
const three = [0, 0, 1];
const sps = [0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01];
const pps = [0x68, 0xce, 0x3c, 0x80];
const sei = [0x06, 0x05, 0x01, 0xaa];
const aud = [0x09, 0xf0];
/** first_mb_in_slice 0: the byte after the header starts with a set bit. */
const idr = [0x65, 0x88, 0x84, 0x00, 0x21];
const pSlice = [0x41, 0x9a, 0x02, 0x10];
/** A second slice of the same picture: first_mb_in_slice is not 0. */
const pSliceMore = [0x41, 0x24, 0x01, 0x10];

const annexB = (...nals: number[][]) => Buffer.from(nals.flatMap((nal) => [...four, ...nal]));

function feed(framer: AnnexBFramer, bytes: Buffer, size: number) {
  const units = [];
  for (let offset = 0; offset < bytes.length; offset += size)
    units.push(...framer.push(bytes.subarray(offset, offset + size)));
  return [...units, ...framer.flush()];
}

describe("Annex B framing", () => {
  const stream = Buffer.concat([
    annexB(sps, pps, idr),
    Buffer.from([...three, ...pSlice]),
    annexB(pSliceMore),
    annexB(aud, pSlice),
    annexB(sei, sps, pps, idr),
  ]);

  it("groups NAL units into one unit per picture, with SPS and PPS as config on the key frame", () => {
    const units = feed(new AnnexBFramer(), stream, stream.length);
    expect(units.map((unit) => [unit.key, unit.config !== undefined])).toEqual([
      [true, true],
      [false, false],
      [false, false],
      [true, true],
    ]);
    expect(units[0]?.data).toEqual(annexB(sps, pps, idr));
    expect(units[0]?.config).toEqual(annexB(sps, pps));
    expect(units[1]?.data).toEqual(annexB(pSlice, pSliceMore));
    expect(units[2]?.data).toEqual(annexB(aud, pSlice));
    expect(units[3]?.data).toEqual(annexB(sei, sps, pps, idr));
    expect(h264CodecString(units[0]?.config ?? Buffer.alloc(0))).toBe("avc1.42c01f");
  });

  it("frames the same way however the chunks cut the stream, even through start codes", () => {
    const whole = feed(new AnnexBFramer(), stream, stream.length);
    for (const size of [1, 2, 3, 5, 7, 11])
      expect(feed(new AnnexBFramer(), stream, size), `chunks of ${size}`).toEqual(whole);
  });

  it("holds the last picture until the next one starts, and drops bytes before the first start code", () => {
    const framer = new AnnexBFramer();
    expect(framer.push(Buffer.concat([Buffer.from([0x12, 0x34]), annexB(sps, pps, idr)]))).toEqual([]);
    expect(framer.push(annexB(pSlice))).toHaveLength(1);
    expect(framer.flush().map((unit) => unit.data)).toEqual([annexB(pSlice)]);
    expect(framer.flush()).toEqual([]);
  });
});

describe("idb video stream", () => {
  it("runs idb video-stream for the simulator and sends each picture as a frame event", async () => {
    const runner = new FakeProcessRunner();
    const events: VideoEvent[] = [];
    const closes: string[] = [];
    let clock = 1_000;
    const session = startIdbVideo({
      runner,
      idb: "/opt/homebrew/bin/idb",
      udid: "AAAA-1111",
      onVideo: (event) => events.push(event),
      onClose: (reason) => closes.push(reason),
      now: () => clock,
    });
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["/opt/homebrew/bin/idb", "video-stream", "--udid", "AAAA-1111", "--format", "h264", "--fps", "30"],
    ]);
    const child = runner.spawned[0];
    if (!child) throw new Error("idb did not start");
    child.emit(annexB(sps, pps, idr));
    clock += 33;
    child.emit(annexB(pSlice));
    child.exit(0);
    await child.exited;
    await Promise.resolve();
    const frames = events.filter((event) => event.type === "frame");
    expect(frames.map((event) => event.type === "frame" && [event.key, event.pts])).toEqual([
      [true, 33_000n],
      [false, 33_000n],
    ]);
    expect(closes).toEqual(["idb stopped streaming video (exit code 0)."]);
    expect(session.closed).toBe(true);
  });

  it("stops idb when the panel closes the stream, without reporting it as ended", async () => {
    const runner = new FakeProcessRunner();
    const closes: string[] = [];
    const session = startIdbVideo({
      runner,
      idb: "idb",
      udid: "AAAA-1111",
      fps: 15,
      onVideo: () => undefined,
      onClose: (reason) => closes.push(reason),
    });
    await session.close();
    expect(runner.spawned[0]?.killed).toBe(true);
    expect(runner.calls[0]?.args.at(-1)).toBe("15");
    expect(closes).toEqual([]);
  });

  it("refuses a udid that is not one, and stays off unless ZLI_MOBILE_IOS_VIDEO is 1", () => {
    expect(() => idbVideoArgs("AAAA; reboot", 30)).toThrow(/not a simulator udid/u);
    expect(iosVideoEnabled({})).toBe(false);
    expect(iosVideoEnabled({ ZLI_MOBILE_IOS_VIDEO: "true" })).toBe(false);
    expect(iosVideoEnabled({ ZLI_MOBILE_IOS_VIDEO: "1" })).toBe(true);
  });
});
