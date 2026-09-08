import assert from "node:assert/strict";
import test from "node:test";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function fixture() {
  const pending = deferred();
  const started = deferred();
  const state = { target: "old", launches: 0, closed: [], disposed: [], errors: [] };
  const operations = {
    isCurrent: () => state.target === "old",
    closeOriginal: async () => { state.closed.push("old"); },
    create: () => { state.launches++; started.resolve(); return pending.promise; },
    swap: (result) => {
      if (state.target !== "old") return false;
      state.target = result.id;
      return true;
    },
    dispose: async (result) => { state.disposed.push(result.id); },
    releaseOriginal: async () => { state.disposed.push("old"); },
    fail: (error) => { state.errors.push(error.message); },
  };
  return { state, operations, pending, started };
}

test("shared terminal lock survives subscriber unmount/remount and concurrent callers", async () => {
  const { terminalRetry } = await import("../src/lib/terminalRetry.ts");
  const f = fixture();
  const unsubscribe = terminalRetry.subscribe(() => {});
  const first = terminalRetry.run("old", f.operations);
  unsubscribe(); // Pane unmounts; a new pane instance subscribes to the same coordinator.
  const remounted = terminalRetry.subscribe(() => {});
  assert.equal(terminalRetry.isRetrying("old"), true);
  const second = terminalRetry.run("old", { ...f.operations });
  assert.equal(first, second);
  await f.started.promise;
  assert.equal(f.state.launches, 1);
  f.pending.resolve({ id: "new", status: "running" });
  await first;
  assert.equal(f.state.target, "new");
  assert.deepEqual(f.state.closed, ["old"]);
  assert.deepEqual(f.state.disposed, ["old"]);
  assert.equal(terminalRetry.isRetrying("old"), false);
  remounted();
});

for (const target of [null, "other"]) {
  test(`disposes late replacement when pane target becomes ${target}`, async () => {
    const { terminalRetry } = await import("../src/lib/terminalRetry.ts");
    const f = fixture();
    const run = terminalRetry.run("old", f.operations);
    await f.started.promise;
    f.state.target = target;
    f.pending.resolve({ id: "new", status: "running" });
    await run;
    assert.equal(f.state.target, target);
    assert.deepEqual(f.state.disposed, ["new"]);
  });
}

test("failed replacement retains original target and scrollback and releases lock", async () => {
  const { terminalRetry } = await import("../src/lib/terminalRetry.ts");
  const f = fixture();
  const run = terminalRetry.run("old", f.operations);
  f.pending.resolve({ id: "failed", status: "error", error: "shell unavailable" });
  await run;
  assert.equal(f.state.target, "old");
  assert.deepEqual(f.state.disposed, ["failed"]);
  assert.deepEqual(f.state.errors, ["shell unavailable"]);
  assert.equal(terminalRetry.isRetrying("old"), false);
});

test("backend close failure prevents another process and preserves scrollback", async () => {
  const { terminalRetry } = await import("../src/lib/terminalRetry.ts");
  const f = fixture();
  f.operations.closeOriginal = async () => { throw new Error("close failed"); };
  await terminalRetry.run("old", f.operations);
  assert.equal(f.state.launches, 0);
  assert.deepEqual(f.state.disposed, []);
  assert.deepEqual(f.state.errors, ["close failed"]);
});

test("exclusive close and retry operations cannot overlap", async () => {
  const { terminalRetry } = await import("../src/lib/terminalRetry.ts");
  const gate = deferred();
  let closeRuns = 0;
  let competingRuns = 0;
  const close = terminalRetry.runExclusive("owned", async () => {
    closeRuns++;
    await gate.promise;
  });
  const competing = await terminalRetry.runExclusive("owned", async () => {
    competingRuns++;
  });
  assert.equal(competing, false);
  assert.equal(terminalRetry.isRetrying("owned"), true);
  gate.resolve();
  assert.equal(await close, true);
  assert.equal(closeRuns, 1);
  assert.equal(competingRuns, 0);
  assert.equal(terminalRetry.isRetrying("owned"), false);
});
