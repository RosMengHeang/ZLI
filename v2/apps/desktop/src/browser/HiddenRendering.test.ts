import { describe, expect, it } from "vitest";

import { createCaptureFallback, createInputWaker } from "./HiddenRendering.js";

describe("hidden view rendering", () => {
  it("wakes the render widget once per renderer process", async () => {
    const toggles: boolean[] = [];
    let processId = 10;
    const sleeps: number[] = [];
    const wake = createInputWaker(
      {
        setBackgroundThrottling: (allowed) => toggles.push(allowed),
        getOSProcessId: () => processId,
        isDestroyed: () => false,
      },
      {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );
    await wake();
    await wake();
    expect(toggles).toEqual([true, false]);
    expect(sleeps).toEqual([120]);

    processId = 11;
    await wake();
    expect(toggles).toEqual([true, false, true, false]);
  });

  it("does nothing for destroyed contents", async () => {
    const toggles: boolean[] = [];
    const wake = createInputWaker({
      setBackgroundThrottling: (allowed) => toggles.push(allowed),
      isDestroyed: () => true,
    });
    await wake();
    expect(toggles).toEqual([]);
  });

  it("captures through capturePage without showing the view", async () => {
    const requests: unknown[] = [];
    const image = { isEmpty: () => false, toPNG: () => Buffer.from("png"), toJPEG: () => Buffer.from("jpg") };
    const capture = createCaptureFallback({
      capturePage: async (_rect, options) => {
        requests.push(options);
        return image;
      },
    });
    expect(await capture?.("png")).toBe(Buffer.from("png").toString("base64"));
    expect(await capture?.("jpeg")).toBe(Buffer.from("jpg").toString("base64"));
    expect(requests[0]).toEqual({ stayHidden: true, stayAwake: true });
    expect(createCaptureFallback({})).toBeUndefined();
    const empty = createCaptureFallback({ capturePage: async () => ({ ...image, isEmpty: () => true }) });
    expect(await empty?.("png")).toBeUndefined();
  });
});
