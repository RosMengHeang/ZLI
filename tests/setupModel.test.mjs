import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

test("coordinator retains successes, catches errors, and retries only failures", async () => {
  const model = await import("../src/components/setup/setupModel.ts");
  const require = createRequire(import.meta.url);
  const slots = [];
  let cursor = 0;
  let completed = 0;
  let browserOpened = false;
  const calls = [];
  const project = {
    project: { name: "Project", path: "D:/project" },
    loading: false,
  };
  const agents = {
    providers: [{ id: "codex", installed: true }],
    providersLoaded: true,
    launch: async (request) => {
      calls.push(request);
      if (calls.length === 2) throw new Error("CLI failed");
      return { id: String(calls.length), status: "running" };
    },
  };
  const useAgentStore = Object.assign((select) => select(agents), {
    getState: () => agents,
  });
  const mocks = {
    react: {
      useEffect() {},
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [
          slots[index],
          (value) => {
            slots[index] =
              typeof value === "function" ? value(slots[index]) : value;
          },
        ];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
    },
    "../stores/agentStore": { useAgentStore },
    "../stores/projectStore": { useProjectStore: (select) => select(project) },
    "../stores/uiStore": {
      useUiStore: (select) =>
        select({
          setBrowserOpen: () => {
            browserOpened = true;
          },
        }),
    },
    "../types": { providerDisplayName: (id) => id },
    "../lib/preferences": { getLastProjectPath: () => null },
    "../lib/ids": { newId: () => "draft" },
    "./AppIcons": {
      IconHelp: "help",
      IconSettings: "settings",
      TaxzyMark: "mark",
    },
    "./setup/setupModel": model,
    "./setup/SetupProjectStep": { SetupProjectStep: "ProjectStep" },
    "./setup/SetupAgentsStep": { SetupAgentsStep: "AgentsStep" },
    "./setup/SetupReviewStep": { SetupReviewStep: "ReviewStep" },
  };
  const source = readFileSync(
    new URL("../src/components/SetupWizard.tsx", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)(
    (id) => mocks[id] ?? require(id),
    exports,
  );
  function render() {
    cursor = 0;
    return exports.SetupWizard({
      onComplete: () => {
        completed += 1;
      },
    });
  }
  function find(node, type) {
    if (!node || typeof node !== "object") return;
    if (node.type === type) return node.props;
    for (const child of [node.props?.children].flat(Infinity)) {
      const found = find(child, type);
      if (found) return found;
    }
  }
  find(render(), "AgentsStep").onAdd("codex");
  find(render(), "AgentsStep").onUpdate("draft", { count: 3 });
  find(render(), "AgentsStep").onContinue();
  const firstReview = find(render(), "ReviewStep");
  const launching = firstReview.onStart();
  await firstReview.onStart(); // Same-render double click cannot duplicate launches.
  await launching;
  const partial = find(render(), "ReviewStep");
  assert.deepEqual(
    partial.items.map((item) => item.status),
    ["running", "failed", "running"],
  );
  assert.equal(partial.items[1].error, "CLI failed");
  assert.equal(completed, 0);
  assert.equal(browserOpened, false);
  await partial.onStart();
  assert.deepEqual(
    calls.map((item) => item.name),
    ["codex 1", "codex 2", "codex 3", "codex 2"],
  );
  assert.ok(calls.every((item) => item.createWorktree));
  assert.equal(completed, 1);
  assert.equal(browserOpened, true);
});

test("retry schedules only failed agents and preserves successful entries", async () => {
  const { pendingLaunchIndexes } =
    await import("../src/components/setup/setupModel.ts");
  const items = ["running", "failed", "starting", "waiting", "failed"].map(
    (status, index) => ({
      provider: "codex",
      name: `Agent ${index}`,
      useWorktree: true,
      status,
    }),
  );
  const before = structuredClone(items);
  assert.deepEqual(pendingLaunchIndexes(items, true), [1, 4]);
  assert.deepEqual(pendingLaunchIndexes(items, false), [3]);
  assert.deepEqual(items, before);
  items[1].status = "running";
  assert.deepEqual(pendingLaunchIndexes(items, true), [4]);
});

test("normalizes invalid quantities and allows more than six agents across tools", async () => {
  const { clampAgentCount, expandLaunchPlan, plannedAgentCount } =
    await import("../src/components/setup/setupModel.ts");
  for (const value of [NaN, Infinity, -Infinity, 0])
    assert.equal(clampAgentCount(value), 1);
  assert.equal(clampAgentCount(3.9), 3);
  const rows = ["codex", "shell"].map((provider) => ({
    id: provider,
    provider,
    role: "  Worker  ",
    count: 6,
    useWorktree: false,
  }));
  assert.equal(plannedAgentCount(rows), 12);
  const plan = expandLaunchPlan(rows);
  assert.equal(plan.length, 12);
  assert.equal(plan[0].name, "Worker 1");
  assert.equal(plan[5].name, "Worker 6");
  assert.equal(plan[6].provider, "shell");
  assert.deepEqual(expandLaunchPlan([]), []);
});

test("clamps agent quantities and totals the launch plan", async () => {
  const { clampAgentCount, plannedAgentCount } =
    await import("../src/components/setup/setupModel.ts");

  assert.equal(clampAgentCount(-2), 1);
  assert.equal(clampAgentCount(3), 3);
  assert.equal(clampAgentCount(12), 6);
  assert.equal(plannedAgentCount([{ count: 2 }, { count: 3 }]), 5);
  assert.equal(plannedAgentCount([{ count: -2 }, { count: 12 }]), 7);
});

test("expands rows into stable user-facing agent names", async () => {
  const { expandLaunchPlan } =
    await import("../src/components/setup/setupModel.ts");

  assert.deepEqual(
    expandLaunchPlan([
      {
        id: "a",
        provider: "codex",
        role: "Reviewer",
        count: 2,
        useWorktree: true,
      },
      { id: "b", provider: "shell", role: "  ", count: 1, useWorktree: false },
    ]),
    [
      { provider: "codex", name: "Reviewer 1", useWorktree: true },
      { provider: "codex", name: "Reviewer 2", useWorktree: true },
      { provider: "shell", name: "shell", useWorktree: false },
    ],
  );
});
