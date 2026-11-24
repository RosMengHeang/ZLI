import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { AccountSignIns, signInCode, signInUrl } from "./AccountSignIns.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

function setup(provider: "codex" | "kimi" | "gemini" = "codex") {
  const dir = mkdtempSync(join(tmpdir(), "zli-signin-"));
  const child = new FakeChild();
  const spawn = vi.fn(() => child as never);
  const onDone = vi.fn();
  const signIns = new AccountSignIns({
    resolveCli: async () => "/bin/agent",
    resolveAccount: async () => ({ provider, env: { CODEX_HOME: dir }, dir }),
    onDone,
    spawn,
    env: {},
  });
  return { signIns, child, spawn, onDone, dir };
}

describe("signInUrl and signInCode", () => {
  it("finds the sign-in page and skips the login's own local page", () => {
    const out =
      "Starting local login server on http://localhost:1455.\nnavigate to this URL to authenticate:\n\u001b[94mhttps://auth.openai.com/oauth/authorize?client_id=x&state=y\u001b[0m\n";
    expect(signInUrl(out)).toBe("https://auth.openai.com/oauth/authorize?client_id=x&state=y");
    expect(signInUrl("https://auth.openai.com/oauth/auth")).toBeUndefined();
  });

  it("reads a one-time code but not one inside a link", () => {
    expect(signInCode("Open https://github.com/login/device and enter one-time code: AB12-CD34\n")).toBe("AB12-CD34");
    expect(signInCode("https://example.com/ABCD-EFGH \n")).toBeUndefined();
  });
});

describe("AccountSignIns", () => {
  it("runs the login with the account folder and reports the page, then that it finished", async () => {
    const { signIns, child, spawn, onDone } = setup();
    const started = await signIns.start("work");
    expect(started).toMatchObject({ accountId: "work", state: "waiting", opensBrowser: true });
    expect(spawn).toHaveBeenCalledWith(
      "/bin/agent",
      ["login"],
      expect.objectContaining({ windowsHide: true, env: expect.objectContaining({ CODEX_HOME: expect.any(String) }) }),
    );
    child.stderr.write("visit https://auth.openai.com/oauth/authorize?x=1 \n");
    expect(signIns.status("work")?.url).toBe("https://auth.openai.com/oauth/authorize?x=1");
    child.emit("close", 0);
    expect(signIns.status("work")?.state).toBe("done");
    expect(onDone).toHaveBeenCalledWith("work");
  });

  it("says what the agent said when the login fails, and stops it on cancel", async () => {
    const { signIns, child } = setup();
    await signIns.start("work");
    child.stdout.write("Error: port 1455 is in use\n");
    child.emit("close", 1);
    expect(signIns.status("work")).toMatchObject({ state: "failed", message: "Error: port 1455 is in use" });

    const second = setup();
    await second.signIns.start("work");
    expect(second.signIns.cancel("work")?.state).toBe("cancelled");
    expect(second.child.killed).toBe(true);
  });

  it("never leaves a login running untracked when Sign in is clicked twice or cancelled while starting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-signin-"));
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    });
    const signIns = new AccountSignIns({
      resolveCli: async () => "/bin/agent",
      resolveAccount: async () => ({ provider: "codex", env: { CODEX_HOME: dir }, dir }),
      spawn,
      env: {},
    });
    // Two clicks before either start has answered: one login runs, and it is the one status and Cancel reach.
    await Promise.all([signIns.start("work"), signIns.start("work")]);
    expect(children.filter((child) => !child.killed)).toHaveLength(1);
    expect(signIns.cancel("work")?.state).toBe("cancelled");
    expect(children.every((child) => child.killed)).toBe(true);

    // Cancel while a start is still on its way stops that login as it begins.
    const pending = signIns.start("work");
    signIns.cancel("work");
    await pending;
    expect(children.every((child) => child.killed)).toBe(true);
  });

  it("shows the code for agents that sign in with one, and leaves terminal-only agents alone", async () => {
    const { signIns, child } = setup("kimi");
    expect(await signIns.start("k")).toMatchObject({ opensBrowser: false });
    child.stdout.write("Visit https://www.kimi.com/code/device?user_code=WXYZ-1234 \nCode: WXYZ-1234\n");
    expect(signIns.status("k")).toMatchObject({
      url: "https://www.kimi.com/code/device?user_code=WXYZ-1234",
      code: "WXYZ-1234",
    });

    expect(await setup("gemini").signIns.start("g")).toBeUndefined();
  });

  it("finishes once the credentials land, even when the login keeps running", async () => {
    // The credentials check reads real files, so each fake step also waits a few real milliseconds for them; a busy
    // machine can need more than one turn of the event loop.
    const realWait = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const { signIns, child, dir } = setup();
      await signIns.start("work");
      writeFileSync(join(dir, "auth.json"), "{}");
      for (let step = 0; step < 100 && signIns.status("work")?.state !== "done"; step += 1) {
        await vi.advanceTimersByTimeAsync(500);
        await new Promise((resolve) => realWait(resolve, 10));
      }
      expect(signIns.status("work")?.state).toBe("done");
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
