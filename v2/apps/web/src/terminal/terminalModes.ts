/**
 * Lets code outside a terminal view ask how the program in a terminal reads input. Only views that
 * are mounted know this, because the modes come from the output xterm has drawn.
 */
type TerminalModes = {
  /** The view has drawn the terminal's history, so its modes reflect the running program. */
  synced(): boolean;
  bracketedPaste(): boolean;
  /** Resolves once output already received has been parsed. */
  flush(): Promise<void>;
};

const views = new Map<string, Set<TerminalModes>>();

export function registerTerminalModes(terminalId: string, modes: TerminalModes): () => void {
  const set = views.get(terminalId) ?? new Set<TerminalModes>();
  set.add(modes);
  views.set(terminalId, set);
  return () => {
    set.delete(modes);
    if (set.size === 0 && views.get(terminalId) === set) views.delete(terminalId);
  };
}

/**
 * Whether the program in the terminal turned on bracketed paste. Waits for a view to mount and draw
 * the history; resolves undefined when none does in time.
 */
export async function readBracketedPaste(terminalId: string, timeoutMs = 3_000): Promise<boolean | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = [...(views.get(terminalId) ?? [])].find((candidate) => candidate.synced());
    if (view) {
      await view.flush();
      return view.bracketedPaste();
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
