import { TerminalStreamMessage } from "@zli-v2/contracts";

export const MAX_TERMINAL_FRAME_BYTES = 1024 * 1024;

export class OutputProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutputProtocolError";
  }
}

export function encodeTerminalStreamMessage(message: unknown): string {
  const parsed = TerminalStreamMessage.parse(message);
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") > MAX_TERMINAL_FRAME_BYTES) {
    throw new OutputProtocolError("Terminal output frame is too large.");
  }
  return encoded;
}

export function decodeTerminalStreamMessage(input: string | Buffer): TerminalStreamMessage {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > MAX_TERMINAL_FRAME_BYTES) {
    throw new OutputProtocolError("Terminal output frame is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof input === "string" ? input : input.toString("utf8")) as unknown;
  } catch (error) {
    throw new OutputProtocolError("Terminal output frame must be valid JSON.", { cause: error });
  }
  const parsed = TerminalStreamMessage.safeParse(value);
  if (!parsed.success) {
    throw new OutputProtocolError("Terminal output frame failed validation.", { cause: parsed.error });
  }
  return parsed.data;
}
