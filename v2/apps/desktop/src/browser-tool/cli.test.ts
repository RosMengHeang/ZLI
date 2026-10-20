import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_HELP, CliUsageError, parseCliArgs, runCli } from "./cli.js";

describe("zli-browser CLI", () => {
  it("parses commands into control actions", () => {
    expect(parseCliArgs([])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["mcp"])).toEqual({ kind: "mcp" });
    expect(parseCliArgs(["open", "localhost:3000", "--new-tab"])).toEqual({
      kind: "call",
      action: "open",
      input: { url: "localhost:3000", newTab: true },
    });
    expect(parseCliArgs(["click", "#save", "--tab", "t1"])).toEqual({
      kind: "call",
      action: "click",
      input: { selector: "#save", browserTabId: "t1" },
    });
    expect(parseCliArgs(["click", "--text=Sign in"])).toMatchObject({ input: { text: "Sign in" } });
    expect(parseCliArgs(["click", "--x", "10", "--y", "20.5"])).toMatchObject({ input: { x: 10, y: 20.5 } });
    expect(parseCliArgs(["fill", "#email", "a@b.c"])).toMatchObject({ input: { selector: "#email", value: "a@b.c" } });
    expect(parseCliArgs(["fill", "#note", ""])).toMatchObject({ input: { value: "" } });
    expect(parseCliArgs(["eval", "document", ".title"])).toMatchObject({
      action: "evaluate",
      input: { expression: "document .title" },
    });
    expect(parseCliArgs(["wait", "--selector", ".ready", "--timeout", "5000"])).toMatchObject({
      input: { selector: ".ready", timeoutMs: 5000 },
    });
    expect(parseCliArgs(["viewport", "iphone-15"])).toMatchObject({ input: { preset: "iphone-15" } });
    expect(parseCliArgs(["viewport", "390x844", "--mobile", "--dpr", "3"])).toMatchObject({
      input: { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
    });
    expect(parseCliArgs(["viewport", "reset"])).toMatchObject({ input: { reset: true } });
    expect(parseCliArgs(["screenshot", "shot.jpg", "--jpeg", "--full-page"])).toMatchObject({
      input: { format: "jpeg", fullPage: true },
      screenshotPath: "shot.jpg",
    });
    expect(parseCliArgs(["tabs", "--cwd", "."])).toMatchObject({ input: { cwd: resolve(".") } });
  });

  it("rejects incomplete or unknown usage", () => {
    expect(() => parseCliArgs(["open"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["click", "--x", "1"])).toThrow("both --x and --y");
    expect(() => parseCliArgs(["click", "--x", "left", "--y", "1"])).toThrow("must be a number");
    expect(() => parseCliArgs(["fill", "#a"])).toThrow("needs a value");
    expect(() => parseCliArgs(["tabs", "--bogus"])).toThrow("Unknown option --bogus");
    expect(() => parseCliArgs(["teleport"])).toThrow("Unknown command teleport");
    expect(() => parseCliArgs(["tabs", "--tab"])).toThrow("--tab needs a value");
  });

  it("prints results, writes screenshots, and exits 1 on failure", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const written: Array<{ path: string; data: Buffer }> = [];
    const io = {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      cwd: () => resolve("/work"),
      writeFile: async (path: string, data: Buffer) => {
        written.push({ path, data });
      },
    };
    expect(await runCli({ kind: "help" }, async () => ({}), io)).toBe(0);
    expect(out.pop()).toBe(CLI_HELP);

    expect(await runCli(parseCliArgs(["tabs"]), async () => ({ tabs: [] }), io)).toBe(0);
    expect(JSON.parse(out.pop() ?? "")).toEqual({ tabs: [] });

    const png = Buffer.from("png-bytes");
    expect(
      await runCli(parseCliArgs(["screenshot", "out.png"]), async () => ({ data: png.toString("base64") }), io),
    ).toBe(0);
    expect(written).toEqual([{ path: resolve("/work", "out.png"), data: png }]);

    expect(
      await runCli(
        parseCliArgs(["tabs"]),
        async () => {
          throw new Error("ZLI is not running, so its browser is unavailable.");
        },
        io,
      ),
    ).toBe(1);
    expect(err.pop()).toBe("ZLI is not running, so its browser is unavailable.\n");
  });
});
