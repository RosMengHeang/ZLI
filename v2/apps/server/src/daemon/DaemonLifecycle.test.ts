import { describe, expect, it } from "vitest";

import { DaemonLifecycle } from "./DaemonLifecycle.js";

function fakeTerminals(initial: Array<"running" | "exited">) {
  const statuses = [...initial];
  let onExit: ((...args: never[]) => void) | undefined;
  return {
    statuses,
    exitAll() {
      statuses.fill("exited");
      onExit?.();
    },
    terminals: {
      list: () => statuses.map((status) => ({ status })) as never,
      stopAll: () => {
        statuses.fill("exited");
        onExit?.();
      },
      subscribeExit: (listener: (...args: never[]) => void) => {
        onExit = listener;
        return () => undefined;
      },
    },
  };
}

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    pending,
    fire() {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
    timers: {
      setTimeout: (callback: () => void) => {
        next += 1;
        pending.set(next, callback);
        return next;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
  };
}

describe("DaemonLifecycle", () => {
  it("exits after a minute with no app connected and no running terminals", () => {
    const clock = fakeTimers();
    let exits = 0;
    const lifecycle = new DaemonLifecycle({
      terminals: fakeTerminals([]).terminals,
      exit: () => (exits += 1),
      timers: clock.timers,
    });
    lifecycle.clientConnected();
    expect(clock.pending.size).toBe(0);
    lifecycle.clientDisconnected();
    expect(clock.pending.size).toBe(1);
    clock.fire();
    expect(exits).toBe(1);
  });

  it("stays up while a terminal runs, so a relaunched app can adopt it", () => {
    const clock = fakeTimers();
    const terminals = fakeTerminals(["running"]);
    let exits = 0;
    const lifecycle = new DaemonLifecycle({
      terminals: terminals.terminals,
      exit: () => (exits += 1),
      timers: clock.timers,
    });
    lifecycle.clientConnected();
    lifecycle.clientDisconnected();
    expect(clock.pending.size).toBe(0);
    terminals.exitAll();
    clock.fire();
    expect(exits).toBe(1);
  });

  it("stops every terminal on shutdown and never exits twice", async () => {
    const terminals = fakeTerminals(["running", "running"]);
    let exits = 0;
    const lifecycle = new DaemonLifecycle({ terminals: terminals.terminals, exit: () => (exits += 1) });
    lifecycle.clientConnected();
    await lifecycle.stopTerminals();
    expect(terminals.statuses).toEqual(["exited", "exited"]);
    lifecycle.exit();
    lifecycle.clientDisconnected();
    expect(exits).toBe(1);
  });

  it("stops terminals that ignored the first stop again on shutdown", async () => {
    const statuses: Array<"running" | "exited"> = ["running"];
    let stops = 0;
    const lifecycle = new DaemonLifecycle({
      terminals: {
        list: () => statuses.map((status) => ({ status })) as never,
        stopAll: () => {
          stops += 1;
          if (stops === 2) statuses.fill("exited");
        },
        subscribeExit: () => () => undefined,
      },
      exit: () => undefined,
      stopTimeoutMs: 2_000,
      forceStopAfterMs: 100,
    });
    const started = Date.now();
    await lifecycle.stopTerminals();
    expect(stops).toBe(2);
    expect(statuses).toEqual(["exited"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
