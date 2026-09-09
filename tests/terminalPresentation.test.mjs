import assert from "node:assert/strict";
import test from "node:test";

test("terminal presentation uses stable compact metrics and restrained colors", async () => {
  const presentation = await import("../src/lib/terminalPresentation.ts").catch(() => ({}));

  assert.deepEqual(presentation.terminalAppearance?.(), {
    fontFamily: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, monospace',
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
      background: "#1f2021",
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
  });
});

test("terminal surface paints unused row space with the terminal background", async () => {
  const presentation = await import("../src/lib/terminalPresentation.ts").catch(() => ({}));
  const xterm = { style: {} };
  const host = {
    style: {},
    querySelector(selector) {
      return selector === ".xterm" ? xterm : null;
    },
  };

  presentation.applyTerminalSurface?.(host);

  assert.equal(host.style.backgroundColor, "#1f2021");
  assert.equal(xterm.style.backgroundColor, "#1f2021");
});
