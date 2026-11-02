import { describe, expect, it } from "vitest";

import { sshCommandHost } from "./CommandHost.js";
import { FakeProcessRunner, type FakeRunHandler } from "./FakeProcessRunner.js";
import { detectRemoteIosTools, REMOTE_PROBE_SCRIPT, sshProblem, testRemoteMac } from "./RemoteMac.js";

const SIMCTL = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      { udid: "AAAA-1111", name: "iPhone 16", state: "Shutdown", isAvailable: true },
      { udid: "BBBB-2222", name: "iPhone 16 Pro", state: "Booted", isAvailable: true },
    ],
  },
});

/** A runner whose answers are keyed on the command line ssh sends to the Mac. */
function mac(answer: (line: string) => ReturnType<FakeRunHandler>) {
  const fake = new FakeProcessRunner((_command, args) => answer(args.at(-1) ?? ""));
  const host = {
    ...sshCommandHost({ runner: fake, ssh: "ssh", host: "dev@studio.local" }),
    remote: "dev@studio.local",
  };
  return { fake, host };
}

const probe = (stdout: string) => (line: string) => (line.includes("/bin/sh") ? { stdout } : undefined);

describe("finding Xcode and idb on the Mac", () => {
  it("runs one fixed probe script and reads what it found", async () => {
    const { fake, host } = mac(probe("simctl=yes\nidb=/opt/homebrew/bin/idb\n"));
    const found = await detectRemoteIosTools(host);
    expect(found.tools).toMatchObject({ xcrun: "/usr/bin/xcrun", idb: "/opt/homebrew/bin/idb" });
    expect(found.tools.host?.remote).toBe("dev@studio.local");
    expect(found.status).toEqual({
      supported: true,
      host: "dev@studio.local",
      simctl: { found: true, path: "/usr/bin/xcrun" },
      idb: { found: true, path: "/opt/homebrew/bin/idb" },
      missing: [],
    });
    const line = fake.calls[0]?.args.at(-1) ?? "";
    expect(line.startsWith("PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /bin/sh -c '")).toBe(true);
    expect(REMOTE_PROBE_SCRIPT).not.toContain("'");
  });

  it("names what is missing on the Mac", async () => {
    const { host } = mac(probe("simctl=no\n"));
    const found = await detectRemoteIosTools(host);
    expect(found.tools.xcrun).toBeUndefined();
    expect(found.status.missing).toEqual([
      "Xcode with the iOS Simulator on studio.local (install Xcode from the App Store, then open it once)",
      "idb on studio.local, for taps, typing, and reading the screen (brew install facebook/fb/idb-companion and pip3 install fb-idb)",
    ]);
  });

  it("says why the Mac could not be reached", async () => {
    const { host } = mac(() => ({
      code: 255,
      stderr: "ssh: connect to host studio.local port 22: Connection refused",
    }));
    const found = await detectRemoteIosTools(host);
    expect(found.status.simctl.found).toBe(false);
    expect(found.status.missing[0]).toMatch(/Turn on Remote Login/u);
  });
});

describe("Test connection", () => {
  it("counts the simulators it found", async () => {
    const { fake, host } = mac((line) =>
      line.includes("simctl list") ? { stdout: SIMCTL } : { stdout: "simctl=yes\nidb=/usr/local/bin/idb\n" },
    );
    expect(await testRemoteMac(host, "dev@studio.local")).toEqual({
      ok: true,
      simulators: 2,
      message: "Connected to studio.local. Found 2 simulators.",
    });
    expect(fake.calls[0]?.args.at(-1)).toBe(
      "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /usr/bin/xcrun simctl list devices --json",
    );
  });

  it("says when idb is missing, and when there are no simulators", async () => {
    const { host } = mac((line) =>
      line.includes("simctl list") ? { stdout: JSON.stringify({ devices: {} }) } : { stdout: "simctl=yes\n" },
    );
    const result = await testRemoteMac(host, "dev@studio.local");
    expect(result.ok).toBe(true);
    expect(result.simulators).toBe(0);
    expect(result.message).toMatch(/^Connected to studio\.local, but it has no iPhone simulators\./u);
    expect(result.message).toMatch(/idb is not installed there/u);
  });

  it("tells the person to set up an SSH key when the Mac refuses it", async () => {
    const { host } = mac(() => ({ code: 255, stderr: "dev@studio.local: Permission denied (publickey,password)." }));
    const result = await testRemoteMac(host, "dev@studio.local");
    expect(result).toEqual({
      ok: false,
      message:
        "studio.local did not accept your SSH key. ZLI signs in with your key and never asks for a password. Add your public key to ~/.ssh/authorized_keys on the Mac, for example with ssh-copy-id dev@studio.local, then test again.",
    });
  });

  it("tells the person to install Xcode when simctl does not run", async () => {
    const { host } = mac(() => ({
      code: 72,
      stderr: 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH',
    }));
    expect((await testRemoteMac(host, "dev@studio.local")).message).toBe(
      "Connected to studio.local, but Xcode's simulator tools did not run there. Install Xcode on the Mac, open it once, then test again.",
    );
  });

  it("explains a missing ssh client", async () => {
    expect((await testRemoteMac(undefined, "studio")).message).toMatch(/add OpenSSH Client/u);
  });

  it("maps each ssh failure to a next step", () => {
    const message = (stderr: string) => sshProblem("dev@studio.local", stderr);
    expect(message("Host key verification failed.")).toBe(
      "This computer does not trust studio.local yet. Run ssh dev@studio.local once in a terminal and accept the Mac's key, then test again.",
    );
    expect(message("ssh: Could not resolve hostname studio.local: No such host is known.")).toMatch(
      /could not find studio\.local on the network/u,
    );
    expect(message("ssh: connect to host studio.local port 22: Connection timed out")).toMatch(/Mac is awake/u);
    expect(message("kex_exchange_identification: something odd")).toBe(
      "ssh could not connect to studio.local: kex_exchange_identification: something odd",
    );
  });
});
