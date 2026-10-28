import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

import type { RpcResponse } from "@zli-v2/contracts";
import { themeColors } from "@zli-v2/ui/colors";
import type { FileLinks } from "../files/FileIndex.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { extendScreenBackground } from "./screenBackground.js";
import { registerTerminalModes } from "./terminalModes.js";

type Props = {
  bridge: ZliBridge;
  terminalId: string;
  running: boolean;
  send(command: Record<string, unknown>): Promise<RpcResponse | undefined>;
  label?: string;
  className?: string;
  autoFocus?: boolean;
  onFocus?(): void;
  /** Makes file paths in the output open with Ctrl+click. */
  fileLinks?: FileLinks | undefined;
};

const RESIZE_DEBOUNCE_MS = 80;
const TERMINAL_FONT = '"JetBrains Mono Variable", "JetBrains Mono", "SFMono-Regular", Consolas, monospace';
const TERMINAL_FONT_SIZE = 12;
const ATTACH_ATTEMPTS = 30;

/** The background matches --zli-terminal so output sits on its tile without a seam. */
export const terminalTheme: ITheme = {
  background: themeColors.terminal,
  foreground: "#dcdcdc",
  cursor: "rgb(180, 203, 255)",
  cursorAccent: themeColors.terminal,
  selectionBackground: "rgba(180, 203, 255, 0.25)",
  black: "#1f1f1f",
  red: "#d77c7c",
  green: "#69c58b",
  yellow: "#d8b56f",
  blue: "#7fa6d9",
  magenta: "#b99ad6",
  cyan: "#72bcc0",
  white: "#cfcfcf",
  brightBlack: "#6f6f6f",
  brightRed: "#e49a9a",
  brightGreen: "#8bd5a5",
  brightYellow: "#e6c98e",
  brightBlue: "#a1bfe6",
  brightMagenta: "#ccb3e3",
  brightCyan: "#95d0d3",
  brightWhite: "#f1f1f1",
};

export function TerminalView({
  bridge,
  terminalId,
  running,
  send,
  label = "Terminal output",
  className = "terminal-output",
  autoFocus = true,
  onFocus,
  fileLinks,
}: Props) {
  const fileLinksRef = useRef(fileLinks);
  fileLinksRef.current = fileLinks;
  const autoFocusRef = useRef(autoFocus);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const sendRef = useRef(send);
  const runningRef = useRef(running);
  sendRef.current = send;
  runningRef.current = running;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: 1.15,
      scrollback: 5_000,
      cursorBlink: false,
      theme: terminalTheme,
      // The Unicode 11 width tables need the proposed unicode API.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // Agent TUIs measure emoji and symbols with Unicode 11+ widths; xterm's default
    // Unicode 6 tables count them as one column, which shifts borders and wraps lines.
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.open(host);
    terminalRef.current = terminal;
    const backgroundExtension = extendScreenBackground(terminal, host, terminalTheme);
    const linkProvider = terminal.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const links = fileLinksRef.current;
        const line = links ? terminal.buffer.active.getLine(lineNumber - 1)?.translateToString(true) : undefined;
        if (!links || !line) {
          callback(undefined);
          return;
        }
        links.touch();
        const found = links.find(line);
        callback(
          found.length === 0
            ? undefined
            : found.map((reference) => ({
                text: line.slice(reference.start, reference.end),
                range: { start: { x: reference.start + 1, y: lineNumber }, end: { x: reference.end, y: lineNumber } },
                decorations: { underline: true, pointerCursor: true },
                // A plain click focuses the terminal or selects text, so opening needs the modifier.
                activate: (event) => {
                  if (event.ctrlKey || event.metaKey) fileLinksRef.current?.open(reference.location);
                },
                hover: () => {
                  host.title = `Ctrl+click to open ${reference.location.path}`;
                },
                leave: () => {
                  host.title = "";
                },
              })),
        );
      },
    });
    let active = true;
    // Snapshots and chunks are broadcast to every pane, including ones answering another caller's
    // attach, so output is only drawn when it continues exactly from the last drawn sequence.
    let synced = false;
    let lastSequence = 0;
    const unregisterModes = registerTerminalModes(terminalId, {
      synced: () => synced,
      bracketedPaste: () => terminal.modes.bracketedPasteMode,
      flush: () => new Promise<void>((resolve) => terminal.write("", resolve)),
    });

    let replaying = false;
    const attach = () => {
      synced = false;
      if (replaying) return;
      replaying = true;
      void (async () => {
        for (let attempt = 0; attempt < ATTACH_ATTEMPTS && active && !synced; attempt += 1) {
          try {
            await bridge.runtime.attachTerminal(terminalId, lastSequence);
          } catch {
            // The terminal can still be starting or the runtime can be reconnecting.
          }
          if (synced) break;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000, 100 * 2 ** attempt)));
        }
        replaying = false;
      })();
    };
    const unsubscribe = bridge.runtime.onTerminal((message) => {
      if (!active) return;
      if (message.kind === "snapshot") {
        const snapshot = message.snapshot;
        if (snapshot.terminalId !== terminalId) return;
        if (snapshot.nextSequence < lastSequence) {
          // A restarted runtime numbers its replayed history from scratch, so draw it again in full.
          terminal.reset();
          lastSequence = 0;
          attach();
          return;
        }
        const fresh = snapshot.chunks.filter((chunk) => chunk.sequence > lastSequence);
        const firstFresh = fresh[0]?.sequence ?? snapshot.nextSequence + 1;
        if (!snapshot.truncated && snapshot.nextSequence > lastSequence && firstFresh > lastSequence + 1) {
          attach();
          return;
        }
        for (const chunk of fresh) terminal.write(decodeBase64(chunk.bytesBase64));
        lastSequence = Math.max(lastSequence, snapshot.nextSequence);
        synced = true;
        return;
      }
      const stream = message.message;
      const streamTerminalId = stream.kind === "chunk" ? stream.chunk.terminalId : stream.terminalId;
      if (streamTerminalId !== terminalId) return;
      if (stream.kind === "chunk") {
        if (!synced || stream.chunk.sequence <= lastSequence) return;
        if (stream.chunk.sequence > lastSequence + 1) {
          attach();
          return;
        }
        terminal.write(decodeBase64(stream.chunk.bytesBase64));
        lastSequence = stream.chunk.sequence;
      } else if (stream.kind === "snapshot_required") {
        attach();
      } else {
        terminal.write(`\r\n\x1b[90m[process exited with code ${stream.code}]\x1b[0m\r\n`);
      }
    });

    const dataSubscription = terminal.onData((data) => {
      if (!runningRef.current) return;
      void sendRef.current({ type: "terminal.write", terminalId, data });
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const syncSize = () => {
      if (!active) return;
      try {
        fit.fit();
      } catch {
        // The host can be detached or zero-sized while the panel is collapsing.
        return;
      }
      if (!runningRef.current) return;
      void sendRef.current({ type: "terminal.resize", terminalId, cols: terminal.cols, rows: terminal.rows });
    };
    const scheduleResize = () => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncSize, RESIZE_DEBOUNCE_MS);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleResize);
    observer?.observe(host);
    loadWebglRenderer(terminal, scheduleResize);
    try {
      fit.fit();
    } catch {
      // Sizing is retried by the resize observer once the host has layout.
    }
    remeasureWhenFontLoads(terminal, () => active, scheduleResize);
    if (autoFocusRef.current) terminal.focus();
    const focusSubscription = terminal.textarea
      ? (() => {
          const textarea = terminal.textarea;
          const listener = () => onFocusRef.current?.();
          textarea.addEventListener("focus", listener);
          return () => textarea.removeEventListener("focus", listener);
        })()
      : undefined;

    attach();

    return () => {
      active = false;
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      observer?.disconnect();
      dataSubscription.dispose();
      linkProvider.dispose();
      backgroundExtension.dispose();
      focusSubscription?.();
      unregisterModes();
      unsubscribe();
      terminalRef.current = undefined;
      terminal.dispose();
    };
  }, [bridge, terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!running || !terminal) return;
    void sendRef.current({ type: "terminal.resize", terminalId, cols: terminal.cols, rows: terminal.rows });
  }, [running, terminalId]);

  return (
    <div
      className={className}
      role="log"
      aria-label={label}
      ref={hostRef}
      onMouseDown={() => terminalRef.current?.focus()}
    />
  );
}

/**
 * The WebGL renderer draws box-drawing, block, and Powerline characters as shapes that fill the cell,
 * so agent logos and borders join up even with the extra line height. The DOM renderer draws them
 * with the font, which leaves seams between rows, so the line height drops to 1 when it is in use.
 * WebGL is unavailable on some machines, and the browser drops the oldest contexts when too many
 * panes are open; both cases fall back to the DOM renderer.
 */
function loadWebglRenderer(terminal: Terminal, onFallback: () => void): void {
  const switchToDomRenderer = () => {
    terminal.options.lineHeight = 1;
    onFallback();
  };
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      switchToDomRenderer();
    });
    terminal.loadAddon(webgl);
  } catch {
    switchToDomRenderer();
  }
}

/**
 * xterm measures its cell size once, when it opens. If the bundled font is still loading at that point
 * the grid is sized for the fallback font, so the cells are measured again after the font arrives.
 */
function remeasureWhenFontLoads(terminal: Terminal, isActive: () => boolean, onMeasured: () => void): void {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  const spec = `${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT}`;
  if (!fonts || fonts.check(spec)) return;
  void fonts
    .load(spec)
    .then(() => {
      if (!isActive()) return;
      // xterm only re-measures when the option value changes, so it is set away and back.
      terminal.options.fontFamily = "monospace";
      terminal.options.fontFamily = TERMINAL_FONT;
      onMeasured();
    })
    .catch(() => undefined);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
