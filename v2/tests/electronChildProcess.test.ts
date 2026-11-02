import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { electronChildProcess } from "./electronChildProcess.js";

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { pid: 42 }) as unknown as ChildProcess;
}

describe("electronChildProcess", () => {
  it("returns the child while the Playwright connection still has it", () => {
    const child = fakeChild();
    expect(electronChildProcess({ process: () => child })).toBe(child);
  });

  it("returns nothing when the app has exited and the dispatcher is gone", () => {
    const app = {
      process: () => {
        throw new TypeError("Cannot read properties of undefined (reading '_object')");
      },
    };
    expect(electronChildProcess(app)).toBeUndefined();
  });

  it("returns nothing when Playwright no longer has a process handle", () => {
    expect(electronChildProcess({ process: () => undefined as unknown as ChildProcess })).toBeUndefined();
  });

  it("rethrows a process lookup that failed for another reason", () => {
    const failure = new Error("electron exited during launch");
    expect(() =>
      electronChildProcess({
        process: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);
  });
});
