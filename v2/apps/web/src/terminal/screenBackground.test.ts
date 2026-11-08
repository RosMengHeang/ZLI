// @vitest-environment jsdom

import type { IBufferCell, Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { cellBackground, extendScreenBackground, paletteColor, screenBackground } from "./screenBackground.js";

const theme = { black: "#1f1f1f", red: "#d77c7c", brightWhite: "#f1f1f1" };

type CellColor = { rgb?: number; palette?: number; inverse?: boolean };

function cell(color: CellColor = {}): IBufferCell {
  return {
    isInverse: () => (color.inverse ? 1 : 0),
    isBgDefault: () => color.rgb === undefined && color.palette === undefined,
    isBgRGB: () => color.rgb !== undefined,
    isBgPalette: () => color.palette !== undefined,
    getBgColor: () => color.rgb ?? color.palette ?? -1,
  } as unknown as IBufferCell;
}

function fakeTerminal(colorAt: (x: number, y: number) => CellColor) {
  let renderListener: (() => void) | undefined;
  const terminal = {
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        viewportY: 100,
        getLine: (y: number) => ({ getCell: (x: number) => cell(colorAt(x, y)) }),
      },
    },
    onRender: (listener: () => void) => {
      renderListener = listener;
      return { dispose: () => (renderListener = undefined) };
    },
  };
  return { terminal: terminal as unknown as Terminal, render: () => renderListener?.() };
}

describe("screen background", () => {
  it("reads palette colors from the theme, the color cube, and the gray ramp", () => {
    expect(paletteColor(1, theme)).toBe("#d77c7c");
    expect(paletteColor(15, theme)).toBe("#f1f1f1");
    expect(paletteColor(16, theme)).toBe("#000000");
    expect(paletteColor(196, theme)).toBe("#ff0000");
    expect(paletteColor(232, theme)).toBe("#080808");
    expect(paletteColor(255, theme)).toBe("#eeeeee");
  });

  it("reads a cell's own background and skips default and inverse cells", () => {
    expect(cellBackground(cell({ rgb: 0x0a0a0a }), theme)).toBe("#0a0a0a");
    expect(cellBackground(cell({ palette: 0 }), theme)).toBe("#1f1f1f");
    expect(cellBackground(cell(), theme)).toBeUndefined();
    expect(cellBackground(cell({ rgb: 0x0a0a0a, inverse: true }), theme)).toBeUndefined();
  });

  it("uses the corners of the viewport and needs all four to agree", () => {
    expect(screenBackground(fakeTerminal(() => ({ rgb: 0x0a0a0a })).terminal, theme)).toBe("#0a0a0a");
    const statusBar = fakeTerminal((_x, y) => (y === 123 ? { rgb: 0x333333 } : { rgb: 0x0a0a0a }));
    expect(screenBackground(statusBar.terminal, theme)).toBeUndefined();
    expect(screenBackground(fakeTerminal(() => ({})).terminal, theme)).toBeUndefined();
  });

  it("paints the host while a TUI covers the screen and clears it after", () => {
    let painted = true;
    const { terminal, render } = fakeTerminal(() => (painted ? { rgb: 0x0a0a0a } : {}));
    const host = document.createElement("div");
    const extension = extendScreenBackground(terminal, host, theme);
    render();
    expect(host.style.backgroundColor).toBe("rgb(10, 10, 10)");
    painted = false;
    render();
    expect(host.style.backgroundColor).toBe("");
    painted = true;
    render();
    extension.dispose();
    expect(host.style.backgroundColor).toBe("");
  });
});
