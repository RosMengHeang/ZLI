import type { ITerminalOptions } from "@xterm/xterm";

export const TERMINAL_FONT_NAME = "JetBrains Mono Variable";
const TERMINAL_BACKGROUND = "#1f2021";

interface TerminalSurfaceElement {
  style: { backgroundColor?: string };
  querySelector(selector: string): TerminalSurfaceElement | null;
}

type TerminalAppearance = Pick<
  ITerminalOptions,
  | "fontFamily"
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "fontWeight"
  | "fontWeightBold"
  | "minimumContrastRatio"
  | "drawBoldTextInBrightColors"
  | "cursorStyle"
  | "cursorWidth"
  | "theme"
>;

export function terminalAppearance(): TerminalAppearance {
  return {
    fontFamily: `"${TERMINAL_FONT_NAME}", "Cascadia Mono", Consolas, monospace`,
    fontSize: 12,
    lineHeight: 1.15,
    letterSpacing: 0,
    fontWeight: "400",
    fontWeightBold: "600",
    minimumContrastRatio: 4.5,
    drawBoldTextInBrightColors: false,
    cursorStyle: "bar",
    cursorWidth: 1,
    theme: {
      background: TERMINAL_BACKGROUND,
      foreground: "#d6d6d6",
      cursor: "#e8e8e8",
      cursorAccent: "#1f2021",
      selectionBackground: "#45474a",
      black: "#1f2021",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#d6d6d6",
      brightBlack: "#7f848e",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  };
}

export function applyTerminalSurface(host: TerminalSurfaceElement): void {
  host.style.backgroundColor = TERMINAL_BACKGROUND;
  const xterm = host.querySelector(".xterm");
  if (xterm) xterm.style.backgroundColor = TERMINAL_BACKGROUND;
  const viewport = host.querySelector(".xterm-viewport");
  if (viewport) viewport.style.backgroundColor = TERMINAL_BACKGROUND;
}

export async function preloadTerminalFont(): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return false;
  const regular = `400 12px "${TERMINAL_FONT_NAME}"`;
  const bold = `600 12px "${TERMINAL_FONT_NAME}"`;
  try {
    await Promise.all([document.fonts.load(regular), document.fonts.load(bold)]);
    return document.fonts.check(regular) && document.fonts.check(bold);
  } catch {
    return false;
  }
}
