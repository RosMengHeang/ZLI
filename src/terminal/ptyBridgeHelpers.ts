export type PtyListen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

const OUTPUT_EVENTS = ["pty-output", "terminal-output"] as const;
const STATUS_EVENTS = ["pty-status", "terminal-status"] as const;
const EXIT_EVENT = "pty-exit";
const ERROR_EVENT = "pty-error";

export function decodeTerminalBytes(
  decoderMap: Map<string, TextDecoder>,
  terminalId: string,
  data: Uint8Array,
): string {
  let decoder = decoderMap.get(terminalId);
  if (!decoder) {
    decoder = new TextDecoder();
    decoderMap.set(terminalId, decoder);
  }
  return decoder.decode(data, { stream: true });
}

export function flushTerminalDecoder(
  decoderMap: Map<string, TextDecoder>,
  terminalId: string,
): string {
  const decoder = decoderMap.get(terminalId);
  if (!decoder) return "";
  decoderMap.delete(terminalId);
  return decoder.decode();
}

/** Bind PTY listeners transactionally. On any failure, unlisten all collected. */
export async function bindPtyListeners(
  listenFn: PtyListen,
  handlers: {
    onOutput: (payload: unknown) => void;
    onStatus: (payload: unknown) => void;
    onExit: (payload: unknown) => void;
    onError: (payload: unknown) => void;
  },
): Promise<Array<() => void>> {
  const collected: Array<() => void> = [];
  try {
    for (const name of OUTPUT_EVENTS) {
      collected.push(await listenFn(name, (event) => handlers.onOutput(event.payload)));
    }
    for (const name of STATUS_EVENTS) {
      collected.push(await listenFn(name, (event) => handlers.onStatus(event.payload)));
    }
    collected.push(await listenFn(EXIT_EVENT, (event) => handlers.onExit(event.payload)));
    collected.push(await listenFn(ERROR_EVENT, (event) => handlers.onError(event.payload)));
    return collected;
  } catch (error) {
    await Promise.all(collected.map((fn) => Promise.resolve(fn())));
    throw error;
  }
}
