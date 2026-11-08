import { describe, expect, it } from "vitest";

import { attachmentUploads, fitWithin, photoName } from "./attachments.js";

describe("photo attachments", () => {
  it("shrinks only photos past the limit, by their longer side", () => {
    expect(fitWithin(1200, 900)).toBeUndefined();
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600 });
    expect(fitWithin(3024, 4032)).toEqual({ height: 1600 });
  });

  it("names every photo as a JPEG", () => {
    expect(photoName("IMG_2041.HEIC", 0)).toBe("IMG_2041.jpg");
    expect(photoName("/data/cache/screen shot.png", 0)).toBe("screen shot.jpg");
    expect(photoName(null, 2)).toBe("photo-3.jpg");
  });

  it("sends file contents, never a phone path", () => {
    expect(attachmentUploads([{ id: "a", uri: "file:///cache/a.jpg", name: "a.jpg", dataBase64: "QUJD" }])).toEqual([
      { name: "a.jpg", mimeType: "image/jpeg", dataBase64: "QUJD" },
    ]);
  });
});
