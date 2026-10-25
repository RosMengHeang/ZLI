import type { TerminalClientMessage } from "@zli-v2/client-runtime";
import { TerminalReadResult } from "@zli-v2/contracts";

import { sendCommand } from "./launch.js";
import type { RemoteLink } from "./link.js";

export type TerminalFeedState = {
  /** Recent output as plain text; the desktop strips color and cursor codes. */
  readonly text: string;
  readonly truncated: boolean;
  readonly loaded: boolean;
  readonly exited: boolean;
  readonly error: string | undefined;
};

type FeedLink = Pick<RemoteLink, "attachTerminal" | "subscribeTerminal" | "command" | "subscribe" | "getSnapshot">;

const READ_BYTES = 64 * 1024;

/**
 * Follows one desktop terminal. Attaching tells the phone when output arrives; the text itself comes
 * from terminal.read, because raw terminal bytes need a full emulator to show correctly.
 */
export class TerminalFeed {
  readonly #link: FeedLink;
  readonly #terminalId: string;
  readonly #throttleMs: number;
  readonly #listeners = new Set<() => void>();
  #state: TerminalFeedState = { text: "", truncated: false, loaded: false, exited: false, error: undefined };
  #stops: (() => void)[] = [];
  #generation = -1;
  /** The newest output sequence seen, so attaching again skips output the phone already knows about. */
  #sequence: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reading = false;
  #dirty = false;
  #active = false;

  constructor(link: FeedLink, terminalId: string, throttleMs = 400) {
    this.#link = link;
    this.#terminalId = terminalId;
    this.#throttleMs = throttleMs;
  }

  getSnapshot = (): TerminalFeedState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#stops = [
      this.#link.subscribeTerminal((message) => this.#onTerminal(message)),
      this.#link.subscribe(() => this.#onLink()),
    ];
    this.#onLink();
  }

  stop(): void {
    this.#active = false;
    for (const stop of this.#stops) stop();
    this.#stops = [];
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async write(data: string): Promise<string | undefined> {
    const sent = await sendCommand(
      this.#link,
      { type: "terminal.write", terminalId: this.#terminalId, data },
      "The input did not reach the terminal.",
    );
    return sent.ok ? undefined : sent.error;
  }

  #set(patch: Partial<TerminalFeedState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** A new connection starts without attachments, so attach again and catch up. */
  #onLink(): void {
    const snapshot = this.#link.getSnapshot();
    if (snapshot.state.kind !== "online" || snapshot.generation === this.#generation) return;
    this.#generation = snapshot.generation;
    const known = snapshot.projection?.terminals.find((terminal) => terminal.terminalId === this.#terminalId);
    try {
      this.#link.attachTerminal(this.#terminalId, this.#sequence ?? known?.lastSequence ?? 0);
    } catch {
      return;
    }
    void this.#read();
  }

  #onTerminal(message: TerminalClientMessage): void {
    const terminalId = message.kind === "snapshot" ? message.snapshot.terminalId : terminalOf(message.message);
    if (terminalId !== this.#terminalId) return;
    if (message.kind === "snapshot") this.#sequence = message.snapshot.nextSequence;
    else if (message.message.kind === "chunk") this.#sequence = message.message.chunk.sequence;
    else if (message.message.kind === "exit") this.#set({ exited: true });
    this.#schedule();
  }

  #schedule(): void {
    if (this.#reading) {
      this.#dirty = true;
      return;
    }
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#read();
    }, this.#throttleMs);
  }

  async #read(): Promise<void> {
    if (!this.#active) return;
    this.#reading = true;
    this.#dirty = false;
    const outcome = await sendCommand(
      this.#link,
      { type: "terminal.read", terminalId: this.#terminalId, maxBytes: READ_BYTES },
      "The terminal output could not be read.",
    );
    this.#reading = false;
    if (!this.#active) return;
    if (outcome.ok) {
      const parsed = TerminalReadResult.safeParse(outcome.result);
      if (parsed.success) {
        this.#set({ text: parsed.data.text, truncated: parsed.data.truncated, loaded: true, error: undefined });
      } else {
        this.#set({ loaded: true, error: "The desktop sent terminal output this app cannot read." });
      }
    } else {
      this.#set({ loaded: true, error: outcome.error });
    }
    if (this.#dirty) this.#schedule();
  }
}

function terminalOf(message: Extract<TerminalClientMessage, { kind: "stream" }>["message"]): string {
  return message.kind === "chunk" ? message.chunk.terminalId : message.terminalId;
}
