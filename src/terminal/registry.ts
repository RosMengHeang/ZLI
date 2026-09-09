import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { terminalAppearance } from "../lib/terminalPresentation";

export interface TerminalEntry {
  terminal: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  dataDisposable: { dispose: () => void } | null;
}

const entries = new Map<string, TerminalEntry>();
const pendingOutput = new Map<string, Array<string | Uint8Array>>();
const MAX_PENDING_CHUNKS = 128;
let holding: HTMLDivElement | null = null;

function holdingTank(): HTMLDivElement {
  if (holding && holding.isConnected) return holding;
  holding = document.createElement("div");
  holding.id = "xterm-holding";
  holding.setAttribute("aria-hidden", "true");
  holding.style.position = "fixed";
  holding.style.left = "-10000px";
  holding.style.top = "0";
  holding.style.width = "8px";
  holding.style.height = "8px";
  holding.style.overflow = "hidden";
  holding.style.opacity = "0";
  holding.style.pointerEvents = "none";
  document.body.appendChild(holding);
  return holding;
}

export const terminalRegistry = {
  has(id: string): boolean {
    return entries.has(id);
  },

  get(id: string): TerminalEntry | undefined {
    return entries.get(id);
  },

  ensure(
    id: string,
    handlers?: { onData?: (data: string) => void },
  ): TerminalEntry {
    const existing = entries.get(id);
    if (existing) {
      if (handlers?.onData) {
        existing.dataDisposable?.dispose();
        existing.dataDisposable = existing.terminal.onData(handlers.onData);
      }
      return existing;
    }

    const terminal = new Terminal({
      ...terminalAppearance(),
      cursorBlink: true,
      scrollback: 2500,
      allowProposedApi: true,
      ...(typeof navigator !== "undefined" && /win/i.test(navigator.platform)
        ? { windowsPty: { backend: "conpty" as const } }
        : {}),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);

    const host = document.createElement("div");
    host.className = "xterm-host";
    host.dataset.terminalId = id;
    holdingTank().appendChild(host);
    terminal.open(host);

    const dataDisposable = handlers?.onData ? terminal.onData(handlers.onData) : null;
    const entry: TerminalEntry = { terminal, fit, host, dataDisposable };
    entries.set(id, entry);
    const buffered = pendingOutput.get(id);
    if (buffered) {
      for (const data of buffered) terminal.write(data);
      pendingOutput.delete(id);
    }
    return entry;
  },

  attach(id: string, container: HTMLElement): void {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.host.parentElement !== container) {
      container.appendChild(entry.host);
    }
  },

  detach(id: string, container?: HTMLElement): void {
    const entry = entries.get(id);
    if (!entry) return;
    if (container && entry.host.parentElement !== container) return;
    holdingTank().appendChild(entry.host);
  },

  fit(id: string): { cols: number; rows: number } | null {
    const entry = entries.get(id);
    if (!entry) return null;
    try {
      entry.fit.fit();
    } catch {
      return null;
    }
    return { cols: entry.terminal.cols, rows: entry.terminal.rows };
  },

  write(id: string, data: string | Uint8Array): void {
    const entry = entries.get(id);
    if (!entry) {
      const buffered = pendingOutput.get(id) ?? [];
      buffered.push(data);
      if (buffered.length > MAX_PENDING_CHUNKS) buffered.shift();
      pendingOutput.set(id, buffered);
      return;
    }
    entry.terminal.write(data);
  },

  focus(id: string): void {
    entries.get(id)?.terminal.focus();
  },

  dispose(id: string): void {
    const entry = entries.get(id);
    if (!entry) return;
    entry.dataDisposable?.dispose();
    entry.terminal.dispose();
    entry.host.remove();
    entries.delete(id);
    pendingOutput.delete(id);
  },
};
