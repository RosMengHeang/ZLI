import { describe, expect, it } from "vitest";

import {
  concatBytes,
  counterBytes,
  equalBytes,
  fromBase64Url,
  readCounter,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "./bytes.js";

describe("bytes", () => {
  it("round-trips base64url for every length and matches the standard alphabet", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) & 0xff);
      const encoded = toBase64Url(bytes);
      const standard = btoa(String.fromCharCode(...bytes));
      expect(encoded).toBe(standard.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""));
      expect(fromBase64Url(encoded)).toEqual(bytes);
    }
  });

  it("rejects malformed base64url", () => {
    expect(() => fromBase64Url("a")).toThrow();
    expect(() => fromBase64Url("ab+c")).toThrow();
    expect(() => fromBase64Url("ab=")).toThrow();
    // "AB" would carry non-zero padding bits; only "AA" encodes a single zero byte.
    expect(() => fromBase64Url("AB")).toThrow();
  });

  it("encodes and decodes UTF-8 like TextEncoder and TextDecoder", () => {
    const samples = ["", "plain", "naïve café", "日本語", "emoji 🚀 and 👩‍💻", "\u0000\u007f\u0080\u07ff\u0800\uffff"];
    for (const sample of samples) {
      const encoded = utf8Encode(sample);
      expect(encoded).toEqual(new TextEncoder().encode(sample));
      expect(utf8Decode(encoded)).toBe(sample);
    }
  });

  it("replaces malformed UTF-8 the way TextDecoder does", () => {
    const malformed = [
      Uint8Array.of(0xff),
      Uint8Array.of(0xc0, 0x80),
      Uint8Array.of(0xe2, 0x82),
      Uint8Array.of(0xed, 0xa0, 0x80),
      Uint8Array.of(0x61, 0xf0, 0x9f, 0x98),
    ];
    for (const bytes of malformed) expect(utf8Decode(bytes)).toBe(new TextDecoder().decode(bytes));
  });

  it("decodes long text without overflowing the call stack", () => {
    const text = "x".repeat(200_000);
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it("writes and reads 8-byte counters", () => {
    for (const value of [0, 1, 255, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      expect(readCounter(counterBytes(value))).toBe(value);
    }
    expect(() => counterBytes(-1)).toThrow();
    expect(() => counterBytes(1.5)).toThrow();
  });

  it("concatenates and compares bytes", () => {
    const joined = concatBytes(Uint8Array.of(1, 2), Uint8Array.of(), Uint8Array.of(3));
    expect(joined).toEqual(Uint8Array.of(1, 2, 3));
    expect(equalBytes(joined, Uint8Array.of(1, 2, 3))).toBe(true);
    expect(equalBytes(joined, Uint8Array.of(1, 2, 4))).toBe(false);
    expect(equalBytes(joined, Uint8Array.of(1, 2))).toBe(false);
  });
});
