import { describe, expect, it } from "vitest";

import { lineSplitter } from "./MobileDriver.js";

describe("line splitter", () => {
  it("keeps a multi-byte character split across chunks whole", () => {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));
    const bytes = Buffer.from("café\nthé", "utf8");
    const cut = bytes.indexOf(0xa9); // the second byte of the first é
    splitter.push(bytes.subarray(0, cut));
    splitter.push(bytes.subarray(cut));
    splitter.end();
    expect(lines).toEqual(["café", "thé"]);
  });

  it("splits lines across chunks and drops the carriage returns", () => {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));
    splitter.push("first li");
    splitter.push("ne\r\nsecond\nthi");
    expect(lines).toEqual(["first line", "second"]);
    splitter.end();
    expect(lines).toEqual(["first line", "second", "thi"]);
  });
});
