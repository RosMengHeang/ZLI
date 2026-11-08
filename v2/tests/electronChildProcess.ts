import type { ChildProcess } from "node:child_process";

type ElectronApplicationLike = {
  process(): ChildProcess;
};

/**
 * The child Playwright launched, or undefined when that lookup can no longer be made.
 * After the app exits, ElectronApplication.process() resolves the dispatcher and reads
 * `_object` on a missing entry, which throws. A failed launch has to keep its original
 * error, so a disposed connection is an absent process, not a new failure.
 */
export function electronChildProcess(app: ElectronApplicationLike): ChildProcess | undefined {
  try {
    const child = app.process();
    if (!child || typeof child.once !== "function") return undefined;
    return child;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("_object")) return undefined;
    throw error;
  }
}
