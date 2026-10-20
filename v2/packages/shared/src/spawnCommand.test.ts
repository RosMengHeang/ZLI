import { describe, expect, it } from "vitest";

import { planSpawn, quoteCmdArgument } from "./spawnCommand.js";

describe("planSpawn", () => {
  it("passes commands through unchanged off Windows", () => {
    expect(planSpawn("/usr/bin/claude", ["-p"], "linux")).toEqual({
      command: "/usr/bin/claude",
      args: ["-p"],
      windowsVerbatimArguments: false,
      wrapped: false,
    });
  });

  it("runs Windows .exe files directly", () => {
    expect(planSpawn("C:\\Tools\\codex.exe", ["app-server"], "win32").wrapped).toBe(false);
  });

  it("wraps .cmd shims in cmd.exe with quoted arguments", () => {
    const plan = planSpawn(
      "C:\\Users\\Dev User\\AppData\\Local\\cursor-agent\\cursor-agent.cmd",
      ["--workspace", "D:\\My Repo"],
      "win32",
      { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
    );
    expect(plan.command).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toBe(
      '"^"C:\\Users\\Dev^ User\\AppData\\Local\\cursor-agent\\cursor-agent.cmd^" ^"--workspace^" ^"D:\\My^ Repo^""',
    );
  });

  it("runs .ps1 scripts through PowerShell", () => {
    const plan = planSpawn("C:\\Tools\\agent.ps1", ["-p"], "win32");
    expect(plan.command).toBe("powershell.exe");
    expect(plan.args.slice(-3)).toEqual(["-File", "C:\\Tools\\agent.ps1", "-p"]);
  });
});

describe("quoteCmdArgument", () => {
  it("escapes embedded quotes and shell metacharacters", () => {
    expect(quoteCmdArgument('a "b" & c')).toBe('^"a^ \\^"b\\^"^ ^&^ c^"');
  });

  it("doubles trailing backslashes before the closing quote", () => {
    expect(quoteCmdArgument("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
  });
});
