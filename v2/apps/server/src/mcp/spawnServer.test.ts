import { describe, expect, it } from "vitest";

import { resolveServerCommand, startProblem } from "./spawnServer.js";

describe("resolveServerCommand", () => {
  const files = new Set(["C:\\Program Files\\nodejs\\npx.cmd", "C:\\tools\\uvx.exe"]);
  const exists = (path: string) => files.has(path);
  const env = { Path: "C:\\tools;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("finds npm shims on Windows PATH", () => {
    expect(resolveServerCommand("npx", env, "win32", exists)).toBe("C:\\Program Files\\nodejs\\npx.cmd");
    expect(resolveServerCommand("uvx", env, "win32", exists)).toBe("C:\\tools\\uvx.exe");
  });

  it("leaves paths, names with an extension, unknown names, and other systems alone", () => {
    expect(resolveServerCommand("C:\\bin\\server.exe", env, "win32", exists)).toBe("C:\\bin\\server.exe");
    expect(resolveServerCommand("npx.cmd", env, "win32", exists)).toBe("npx.cmd");
    expect(resolveServerCommand("missing", env, "win32", exists)).toBe("missing");
    expect(resolveServerCommand("npx", env, "linux", exists)).toBe("npx");
  });
});

describe("startProblem", () => {
  const missing = Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });

  it("says what to install for well-known commands", () => {
    expect(startProblem("npx", missing)).toBe("ZLI could not start npx. Install Node.js, then try again.");
    expect(startProblem("C:\\Python\\python.exe", missing)).toBe(
      "ZLI could not start python.exe. Install Python, then try again.",
    );
    expect(startProblem("my-server", missing)).toBe(
      "ZLI could not start my-server. Check that my-server is installed and on your PATH, then try again.",
    );
  });

  it("covers permissions and anything else", () => {
    expect(startProblem("/opt/s", Object.assign(new Error("x"), { code: "EACCES" }))).toContain("not allowed to run");
    expect(startProblem("s", new Error("Bad things."))).toBe("ZLI could not start s: Bad things.");
  });
});
