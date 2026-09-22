import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { closeChildProcess } from "./closeChildProcess.js";
import { getProcessTreeTerminationOrder } from "./processTree.js";

describe("closeChildProcess", () => {
  it("lets graceful shutdown finish and waits for stdio close", async () => {
    const child = new EventEmitter();
    const terminate = vi.fn(async () => undefined);
    const closeGracefully = vi.fn(async () => {
      queueMicrotask(() => child.emit("close", 0, null));
    });

    await closeChildProcess(closeGracefully, child, terminate, 50);

    expect(closeGracefully).toHaveBeenCalledOnce();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("force-terminates only when graceful shutdown times out", async () => {
    const child = new EventEmitter();
    const terminate = vi.fn(async () => {
      child.emit("close", null, "SIGTERM");
    });

    await closeChildProcess(() => new Promise(() => undefined), child, terminate, 5);

    expect(terminate).toHaveBeenCalledOnce();
  });

  it("force-terminates when the app closes but child stdio never closes", async () => {
    const child = new EventEmitter();
    const terminate = vi.fn(async () => {
      child.emit("close", 0, null);
    });

    await closeChildProcess(async () => undefined, child, terminate, 5);

    expect(terminate).toHaveBeenCalledOnce();
  });
});

describe("getProcessTreeTerminationOrder", () => {
  it("terminates descendants before their parents and ignores unrelated processes", () => {
    expect(getProcessTreeTerminationOrder(10, "10 1\n11 10\n12 11\n13 10\n20 1\ninvalid row\n")).toEqual([
      12, 11, 13, 10,
    ]);
  });

  it("handles cycles without revisiting a process", () => {
    expect(getProcessTreeTerminationOrder(10, "10 12\n11 10\n12 11\n")).toEqual([12, 11, 10]);
  });
});
