import { describe, expect, it } from "vitest";

import {
  findSsh,
  remoteCommandLine,
  SSH_OPTIONS,
  shellQuote,
  sshArgs,
  sshCommandHost,
  sshHostName,
} from "./CommandHost.js";
import { FakeProcessRunner } from "./FakeProcessRunner.js";
import type { MobileFileSystem } from "./host.js";

describe("shell quoting for the Mac", () => {
  it("leaves plain words alone and single-quotes everything else", () => {
    expect(shellQuote("simctl")).toBe("simctl");
    expect(shellQuote("/usr/bin/xcrun")).toBe("/usr/bin/xcrun");
    expect(shellQuote("AAAA-1111")).toBe("AAAA-1111");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("iPhone 15 Pro")).toBe("'iPhone 15 Pro'");
    expect(shellQuote("--type=png")).toBe("'--type=png'");
  });

  it("keeps quotes, substitutions, and separators from reaching the shell", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(reboot)")).toBe("'$(reboot)'");
    expect(shellQuote("`id`; rm -rf ~ && echo")).toBe("'`id`; rm -rf ~ && echo'");
    expect(shellQuote("https://example.com/?a=1&b=$HOME")).toBe("'https://example.com/?a=1&b=$HOME'");
    expect(shellQuote("line\nbreak")).toBe("'line\nbreak'");
  });

  it("builds one command line with the Homebrew folders on PATH", () => {
    expect(remoteCommandLine("/usr/bin/xcrun", ["simctl", "openurl", "AAAA", "exp://x?y=1&z"])).toBe(
      "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /usr/bin/xcrun simctl openurl AAAA 'exp://x?y=1&z'",
    );
  });
});

describe("ssh arguments", () => {
  it("never asks for a password, gives up quickly, and ends ssh's options before the host", () => {
    expect(SSH_OPTIONS).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]);
    expect(sshArgs("dev@mac-mini.local", "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"])).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "--",
      "dev@mac-mini.local",
      "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /usr/bin/xcrun simctl list devices --json",
    ]);
  });

  it("refuses an address that ssh would read as an option or a shell would split", () => {
    for (const host of ["-oProxyCommand=calc", "dev@-oProxyCommand=x", "mac mini", "mac;reboot", "", "a@b@c"])
      expect(() => sshArgs(host, "true", [])).toThrow();
  });

  it("names the Mac without the user", () => {
    expect(sshHostName("dev@mac-mini.local")).toBe("mac-mini.local");
    expect(sshHostName("studio")).toBe("studio");
  });

  it("runs and spawns through ssh, without a local working folder", async () => {
    const fake = new FakeProcessRunner(() => ({ stdout: "ok" }));
    const host = sshCommandHost({ runner: fake, ssh: "/usr/bin/ssh", host: "dev@studio" });
    expect(host.remote).toBe("dev@studio");
    const result = await host.runner.run("/usr/bin/xcrun", ["simctl", "boot", "AAAA"], {
      cwd: "C:\\work",
      timeoutMs: 5_000,
      env: { PATH: "/usr/bin" },
    });
    expect(result.stdout.toString()).toBe("ok");
    host.runner.spawn("/usr/bin/xcrun", ["simctl", "spawn", "AAAA", "log", "stream"], { cwd: "C:\\work" });
    expect(fake.calls.map((call) => call.command)).toEqual(["/usr/bin/ssh", "/usr/bin/ssh"]);
    expect(fake.calls[0]?.args.at(-1)).toBe(
      "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /usr/bin/xcrun simctl boot AAAA",
    );
    expect(fake.calls[0]?.options).toEqual({ timeoutMs: 5_000, env: { PATH: "/usr/bin" } });
    expect(fake.calls[1]?.options).toEqual({});
  });
});

describe("finding ssh", () => {
  const fs = (files: string[]): MobileFileSystem => ({
    exists: async (path) => files.includes(path),
    isDirectory: async () => false,
    readdir: async () => [],
    readFile: async () => "",
  });

  it("uses ssh on PATH first", async () => {
    expect(await findSsh({ PATH: "/usr/local/bin:/usr/bin" }, "linux", fs(["/usr/bin/ssh"]))).toBe("/usr/bin/ssh");
  });

  it("falls back to the OpenSSH client Windows installs as an optional feature", async () => {
    const path = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
    expect(await findSsh({ PATH: "", SystemRoot: "C:\\Windows" }, "windows", fs([path]))).toBe(path);
    expect(await findSsh({ PATH: "", SystemRoot: "C:\\Windows" }, "windows", fs([]))).toBeUndefined();
  });
});
