import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

export interface TerminalEntry {
  terminal: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  dataDisposable: { dispose: () => void } | null;
}

const entries = new Map<string, TerminalEntry>();
let holding: HTMLDivElement | null = null;

const XTERM_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#aeafad",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#1e1e1e",
  red: "#f44747",
  green: "#6a9955",
  yellow: "#dcdcaa",
  blue: "#569cd6",
  magenta: "#c586c0",
  cyan: "#4ec9b0",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#f44747",
  brightGreen: "#6a9955",
  brightYellow: "#dcdcaa",
  brightBlue: "#569cd6",
  brightMagenta: "#c586c0",
  brightCyan: "#4ec9b0",
  brightWhite: "#ffffff",
};

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
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: XTERM_THEME,
      scrollback: 5000,
      allowProposedApi: true,
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
    if (!entry) return;
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
  },
};
