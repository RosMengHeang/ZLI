import type { IBufferCell, ITheme, Terminal } from "@xterm/xterm";

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const hex = (red: number, green: number, blue: number) =>
  `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/** The color of an entry in the 256-color palette: the theme's 16 colors, then xterm's cube and grays. */
export function paletteColor(index: number, theme: ITheme): string | undefined {
  if (index < 16) return theme[ANSI_KEYS[index] ?? "black"];
  if (index < 232) {
    const cube = index - 16;
    return hex(
      CUBE_LEVELS[Math.floor(cube / 36)] ?? 0,
      CUBE_LEVELS[Math.floor(cube / 6) % 6] ?? 0,
      CUBE_LEVELS[cube % 6] ?? 0,
    );
  }
  const gray = 8 + (index - 232) * 10;
  return hex(gray, gray, gray);
}

/** A cell's own background, or undefined when it shows the theme background or its colors are swapped. */
export function cellBackground(cell: IBufferCell | undefined, theme: ITheme): string | undefined {
  if (!cell || cell.isInverse() || cell.isBgDefault()) return undefined;
  const value = cell.getBgColor();
  if (cell.isBgRGB()) return hex((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  if (cell.isBgPalette()) return paletteColor(value, theme);
  return undefined;
}

/**
 * The background a full-screen TUI paints across the whole screen, read from the four corner cells
 * of the viewport. Undefined when they disagree or use the theme background.
 */
export function screenBackground(terminal: Terminal, theme: ITheme): string | undefined {
  const buffer = terminal.buffer.active;
  const top = buffer.viewportY;
  const bottom = top + terminal.rows - 1;
  const right = terminal.cols - 1;
  const corners = [
    [0, top],
    [right, top],
    [0, bottom],
    [right, bottom],
  ] as const;
  const colors = corners.map(([x, y]) => cellBackground(buffer.getLine(y)?.getCell(x), theme));
  const [first] = colors;
  return first !== undefined && colors.every((color) => color === first) ? first : undefined;
}

/**
 * TUIs such as OpenCode paint every cell with their own background. The padding around the grid and
 * the part of a cell the fit leaves over would otherwise show the theme background as a frame around
 * the app, so the host takes the TUI's background while it covers the screen.
 */
export function extendScreenBackground(terminal: Terminal, host: HTMLElement, theme: ITheme): { dispose(): void } {
  let current = "";
  const update = () => {
    const color = screenBackground(terminal, theme) ?? "";
    if (color === current) return;
    current = color;
    host.style.backgroundColor = color;
  };
  const subscription = terminal.onRender(update);
  return {
    dispose: () => {
      subscription.dispose();
      host.style.backgroundColor = "";
    },
  };
}
