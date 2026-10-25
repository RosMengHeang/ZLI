import { describe, expect, it } from "vitest";

import { webCryptoRandomBytes as randomBytes, toBase64Url, utf8Encode } from "./bytes.js";
import { decodePairingCode, encodePairingCode, type PairingCode, PairingCodeError } from "./pairingCode.js";

const code: PairingCode = {
  v: 1,
  name: "Studio Mac",
  hosts: ["192.168.1.20", "10.0.0.4"],
  port: 47_120,
  key: toBase64Url(randomBytes(32)),
  pairingId: toBase64Url(randomBytes(16)),
  secret: toBase64Url(randomBytes(32)),
  expiresAt: 1_800_000_000_000,
};

describe("pairing codes", () => {
  it("round-trips through the text a QR code carries", () => {
    const text = encodePairingCode(code);
    expect(text.startsWith("zli-remote:")).toBe(true);
    expect(text).toMatch(/^[A-Za-z0-9:_-]+$/u);
    expect(decodePairingCode(text)).toEqual(code);
  });

  it("accepts pasted text with line breaks and spaces", () => {
    const text = encodePairingCode(code);
    const wrapped = ` ${text.slice(0, 30)}\n${text.slice(30, 60)} \n${text.slice(60)}\n`;
    expect(decodePairingCode(wrapped)).toEqual(code);
  });

  it("explains what is wrong with a bad code", () => {
    expect(() => decodePairingCode("https://example.com")).toThrow(/not a ZLI pairing code/u);
    expect(() => decodePairingCode("zli-remote:%%%")).toThrow(/damaged/u);
    const future = `zli-remote:${toBase64Url(utf8Encode(JSON.stringify({ ...code, v: 2 })))}`;
    expect(() => decodePairingCode(future)).toThrow(/different ZLI version/u);
    const missing = `zli-remote:${toBase64Url(utf8Encode(JSON.stringify({ ...code, hosts: [] })))}`;
    expect(() => decodePairingCode(missing)).toThrow(PairingCodeError);
  });

  it("refuses to encode a code that would not decode", () => {
    expect(() => encodePairingCode({ ...code, hosts: ["bad host!"] })).toThrow();
  });
});
