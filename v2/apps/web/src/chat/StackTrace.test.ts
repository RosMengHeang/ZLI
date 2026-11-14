import { describe, expect, it } from "vitest";

import { parseStackTrace } from "./StackTrace.js";

describe("parseStackTrace", () => {
  it("reads a Node trace with the error above its frames", () => {
    const trace = parseStackTrace(
      [
        "$ node app.js",
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at loadUser (/repo/src/users.ts:42:17)",
        "    at async Promise.all (index 0)",
        "    at Object.<anonymous> (/repo/node_modules/express/lib/router.js:12:3)",
        "    at node:internal/main/run_main_module:28:49",
      ].join("\n"),
    );
    expect(trace?.before).toEqual(["$ node app.js"]);
    expect(trace?.errorType).toBe("TypeError");
    expect(trace?.message).toBe("Cannot read properties of undefined (reading 'id')");
    expect(trace?.frames.map((frame) => frame.location?.file)).toEqual([
      "/repo/src/users.ts",
      undefined,
      "/repo/node_modules/express/lib/router.js",
      "node:internal/main/run_main_module",
    ]);
    expect(trace?.frames.map((frame) => frame.vendor)).toEqual([false, false, true, true]);
    const [first] = trace?.frames ?? [];
    expect(first?.location).toMatchObject({ line: 42, column: 17 });
    expect(first?.text.slice(first.location?.start, first.location?.end)).toBe("/repo/src/users.ts:42:17");
  });

  it("reads a Python traceback with the error below its frames and keeps each source line", () => {
    const trace = parseStackTrace(
      [
        "Traceback (most recent call last):",
        '  File "/repo/app/main.py", line 8, in <module>',
        "    run()",
        '  File "/usr/lib/python3.12/site-packages/click/core.py", line 1157, in __call__',
        "    return self.main(*args, **kwargs)",
        "ValueError: bad input",
      ].join("\n"),
    );
    expect(trace?.before).toEqual(["Traceback (most recent call last):"]);
    expect(trace?.errorType).toBe("ValueError");
    expect(trace?.message).toBe("bad input");
    expect(trace?.frames).toHaveLength(2);
    expect(trace?.frames[0]).toMatchObject({
      code: "run()",
      vendor: false,
      location: { file: "/repo/app/main.py", line: 8 },
    });
    expect(trace?.frames[1]?.vendor).toBe(true);
    expect(trace?.after).toEqual([]);
  });

  it("joins Rust and Go frames that print the function and the file on separate lines", () => {
    const rust = parseStackTrace(
      [
        "thread 'main' panicked at src/main.rs:4:5:",
        "boom",
        "stack backtrace:",
        "   0: std::panicking::begin_panic",
        "             at /rustc/abc/library/std/src/panicking.rs:652:12",
        "   1: demo::main",
        "             at ./src/main.rs:4:5",
      ].join("\n"),
    );
    expect(rust?.frames.map((frame) => [frame.location?.file, frame.vendor])).toEqual([
      ["/rustc/abc/library/std/src/panicking.rs", true],
      ["./src/main.rs", false],
    ]);

    const go = parseStackTrace(
      [
        "panic: runtime error: index out of range [3] with length 3",
        "",
        "goroutine 1 [running]:",
        "main.main()",
        "\t/home/me/demo/main.go:9 +0x1d",
      ].join("\n"),
    );
    expect(go?.frames).toHaveLength(1);
    expect(go?.frames[0]?.location).toMatchObject({ file: "/home/me/demo/main.go", line: 9 });
    expect(go?.errorType).toBe("panic");
    expect(go?.message).toBe("runtime error: index out of range [3] with length 3");
    expect(go?.before).toEqual(["goroutine 1 [running]:"]);
  });

  it("leaves text without a frame that names a file alone", () => {
    expect(parseStackTrace("Error: the request timed out")).toBeUndefined();
    expect(parseStackTrace("Look at the logs\nat least once")).toBeUndefined();
    expect(parseStackTrace("")).toBeUndefined();
  });
});
