/**
 * Knows, per terminal, whether the person has typed something they have not sent with Enter yet.
 * Huddle messages wait while that is so, because typing a message into the terminal would mix with
 * the person's half-written line.
 *
 * Only keystrokes from ZLI windows pass through here. The count is a guess at the line length: it
 * cannot see what the agent CLI does with arrow keys or its own shortcuts.
 */
export class TerminalInputTracker {
  private readonly unsent = new Map<string, number>();
  private readonly listeners = new Set<(terminalId: string) => void>();

  record(terminalId: string, data: string): void {
    const before = this.unsent.get(terminalId) ?? 0;
    let count = before;
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index] as string;
      if (char === "\u001b") {
        index = skipEscape(data, index);
        continue;
      }
      if (char === "\r" || char === "\n" || char === "\u0003" || char === "\u0015") count = 0;
      else if (char === "\u007f" || char === "\b") count = Math.max(0, count - 1);
      else if (char >= " ") count += 1;
    }
    if (count === 0) this.unsent.delete(terminalId);
    else this.unsent.set(terminalId, count);
    if (before > 0 !== count > 0) for (const listener of this.listeners) listener(terminalId);
  }

  hasUnsent(terminalId: string): boolean {
    return (this.unsent.get(terminalId) ?? 0) > 0;
  }

  forget(terminalId: string): void {
    if (!this.unsent.delete(terminalId)) return;
    for (const listener of this.listeners) listener(terminalId);
  }

  /** Called when a terminal starts or stops having unsent input. */
  onChange(listener: (terminalId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Returns the index of the last character of the escape sequence that starts at `start`. */
function skipEscape(data: string, start: number): number {
  const next = data[start + 1];
  if (next !== "[" && next !== "O") return Math.min(start + 1, data.length - 1);
  for (let index = start + 2; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    // A CSI or SS3 sequence ends at its first character in the range @ to ~.
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return data.length - 1;
}
