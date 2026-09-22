import type { ChildProcess } from "node:child_process";

export async function closeChildProcess(
  closeGracefully: () => Promise<unknown>,
  child: Pick<ChildProcess, "once">,
  terminate: () => Promise<void>,
  timeoutMs = 2_000,
): Promise<void> {
  const childClosed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  const closeAttempt = Promise.resolve()
    .then(closeGracefully)
    .then(
      () => undefined,
      () => undefined,
    );
  const firstResult = await firstToSettle([closeAttempt, childClosed], timeoutMs);
  if (!firstResult) await terminate();

  if (!(await settlesWithin(childClosed, timeoutMs))) {
    await terminate();
    await settlesWithin(childClosed, timeoutMs);
  }
  await settlesWithin(closeAttempt, timeoutMs);
}

async function firstToSettle(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  const settled = promises.map((promise) => promise.then(() => true));
  return settlesWithin(Promise.race(settled), timeoutMs);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
