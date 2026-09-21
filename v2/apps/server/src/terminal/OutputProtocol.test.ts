import { describe, expect, it } from "vitest";

import { TerminalId } from "@zli-v2/contracts";

import {
  MAX_TERMINAL_FRAME_BYTES,
  OutputProtocolError,
  decodeTerminalStreamMessage,
  encodeTerminalStreamMessage,
} from "./OutputProtocol.js";

const terminalId = TerminalId.parse("00000000-0000-4000-8000-000000000401");

describe("terminal output protocol", () => {
  it("round-trips chunk and exit messages with base64 bytes", () => {
    const encoded = encodeTerminalStreamMessage({
      kind: "chunk",
      chunk: {
        terminalId,
        sequence: 3,
        bytesBase64: Buffer.from("🙂\n").toString("base64"),
      },
    });
    expect(decodeTerminalStreamMessage(encoded)).toEqual({
      kind: "chunk",
      chunk: {
        terminalId,
        sequence: 3,
        bytesBase64: Buffer.from("🙂\n").toString("base64"),
      },
    });
  });

  it("rejects malformed or oversized frames before they reach the runtime", () => {
    expect(() => decodeTerminalStreamMessage("not-json")).toThrowError(OutputProtocolError);
    const oversized = JSON.stringify({ kind: "snapshot_required", terminalId, nextSequence: "x".repeat(MAX_TERMINAL_FRAME_BYTES) });
    expect(() => decodeTerminalStreamMessage(oversized)).toThrowError(/frame is too large/);
  });
});
