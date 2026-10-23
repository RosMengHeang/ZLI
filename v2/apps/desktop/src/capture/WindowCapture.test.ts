import { describe, expect, it } from "vitest";

import {
  type CaptureDependencies,
  captureSize,
  captureSource,
  listCaptureSources,
  parseSourceId,
} from "./WindowCapture.js";

const image = (data: string) => ({
  isEmpty: () => data === "",
  toDataURL: () => `data:image/png;base64,${data}`,
  toPNG: () => new TextEncoder().encode(data),
});

function deps(sources: { id: string; name: string; data: string }[]): CaptureDependencies & { sizes: unknown[] } {
  const sizes: unknown[] = [];
  return {
    sizes,
    getSources: async (options) => {
      sizes.push(options.thumbnailSize);
      return sources
        .filter((source) => options.types.some((type) => source.id.startsWith(`${type}:`)))
        .map((source) => ({ id: source.id, name: source.name, thumbnail: image(source.data) }));
    },
    largestDisplay: () => ({ width: 5_120, height: 2_880 }),
  };
}

describe("window capture", () => {
  it("lists windows before screens and skips sources without a picture", async () => {
    const list = await listCaptureSources(
      deps([
        { id: "screen:0:0", name: "Entire screen", data: "s" },
        { id: "window:1:0", name: "Editor", data: "w" },
        { id: "window:2:0", name: "Minimized", data: "" },
        { id: "window:3:0", name: "  ", data: "u" },
      ]),
    );
    expect(list.map((source) => [source.name, source.kind])).toEqual([
      ["Editor", "window"],
      ["Untitled window", "window"],
      ["Entire screen", "screen"],
    ]);
  });

  it("captures one source at display size, capped for very large screens", async () => {
    const capture = deps([{ id: "window:1:0", name: "Editor", data: "png" }]);
    await expect(captureSource(capture, "window:1:0")).resolves.toEqual({
      name: "Editor",
      dataBase64: Buffer.from("png").toString("base64"),
    });
    expect(capture.sizes).toEqual([{ width: 3_840, height: 2_160 }]);
    expect(captureSize({ width: 1_920, height: 1_080 })).toEqual({ width: 1_920, height: 1_080 });
  });

  it("explains when the window is gone", async () => {
    await expect(captureSource(deps([]), "window:9:0")).rejects.toThrow("closed or hidden");
  });

  it("accepts only source ids", () => {
    expect(parseSourceId({ id: "window:123:0" })).toBe("window:123:0");
    expect(() => parseSourceId({ id: "../etc" })).toThrow();
    expect(() => parseSourceId(undefined)).toThrow();
  });
});
