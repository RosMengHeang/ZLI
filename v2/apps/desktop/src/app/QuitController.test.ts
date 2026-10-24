import { describe, expect, it, vi } from "vitest";

import { busyAgentCount, QuitController, quitWarning } from "./QuitController.js";

function controller(
  overrides: { busy?: number; agree?: boolean; shutdown?: () => Promise<void>; timeoutMs?: number } = {},
) {
  const calls: string[] = [];
  let answer: ((agreed: boolean) => void) | undefined;
  const quit = new QuitController({
    quit: () => calls.push("quit"),
    busyAgents: () => overrides.busy ?? 0,
    confirm: (count) => {
      calls.push(`confirm:${count}`);
      return overrides.agree === undefined
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve(overrides.agree);
    },
    shutdown:
      overrides.shutdown ??
      (async () => {
        calls.push("shutdown");
      }),
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
  });
  const event = () => {
    const prevented = { value: false };
    return { prevented, preventDefault: () => (prevented.value = true) };
  };
  return { quit, calls, event, answer: (agreed: boolean) => answer?.(agreed) };
}

describe("QuitController", () => {
  it("shuts down before letting an idle app quit", async () => {
    const { quit, calls, event } = controller();
    const first = event();
    quit.beforeQuit(first);
    expect(first.prevented.value).toBe(true);
    expect(quit.exiting).toBe(true);
    await vi.waitFor(() => expect(calls).toEqual(["shutdown", "quit"]));

    const second = event();
    quit.beforeQuit(second);
    expect(second.prevented.value).toBe(false);
  });

  it("asks first when agents are working, and stays open when the person cancels", async () => {
    const { quit, calls, event, answer } = controller({ busy: 2 });
    quit.beforeQuit(event());
    expect(calls).toEqual(["confirm:2"]);
    expect(quit.exiting).toBe(false);
    // A second quit while the question is open does not ask again.
    quit.beforeQuit(event());
    answer(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["confirm:2"]);
    expect(quit.exiting).toBe(false);
  });

  it("quits after the person agrees, without asking again", async () => {
    const { quit, calls, event } = controller({ busy: 1, agree: true });
    quit.beforeQuit(event());
    await vi.waitFor(() => expect(calls).toEqual(["confirm:1", "quit"]));
    quit.beforeQuit(event());
    await vi.waitFor(() => expect(calls).toEqual(["confirm:1", "quit", "shutdown", "quit"]));
  });

  it("does not ask when a caller already stopped everything for an update", async () => {
    const { quit, calls, event } = controller({ busy: 3 });
    await quit.stop();
    const quitting = event();
    quit.beforeQuit(quitting);
    expect(quitting.prevented.value).toBe(false);
    expect(calls).toEqual(["shutdown"]);
  });

  it("quits anyway when the shutdown fails or hangs", async () => {
    const failing = controller({ shutdown: () => Promise.reject(new Error("daemon gone")) });
    failing.quit.beforeQuit(failing.event());
    await vi.waitFor(() => expect(failing.calls).toEqual(["quit"]));

    const hanging = controller({ shutdown: () => new Promise(() => undefined), timeoutMs: 20 });
    hanging.quit.beforeQuit(hanging.event());
    await vi.waitFor(() => expect(hanging.calls).toEqual(["quit"]));
  });
});

describe("busyAgentCount", () => {
  it("counts chats that are working or waiting inside a turn", () => {
    expect(
      busyAgentCount({
        threads: [{ status: "working" }, { status: "waiting" }, { status: "idle" }, { status: "stopped" }],
      }),
    ).toBe(2);
    expect(busyAgentCount(undefined)).toBe(0);
  });

  it("says how many agents a quit stops", () => {
    expect(quitWarning(1)).toBe("An agent is still working. Quitting ZLI stops it in the middle of its turn.");
    expect(quitWarning(3)).toBe("3 agents are still working. Quitting ZLI stops them in the middle of their turns.");
  });
});
