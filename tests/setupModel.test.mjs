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
  const retired = [];
  const project = {
    project: { name: "Project", path: "D:/project" },
    loading: false,
  };
  const agents = {
    providers: [{ id: "codex", installed: true }],
    providersLoaded: true,
    retireFailed: async (id) => { retired.push(id); },
    launch: async (request) => {
      calls.push(request);
      if (calls.length === 2) return { id: "failed-attempt", status: "error", error: "CLI failed" };
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
    "../stores/terminalStore": {
      useTerminalStore: Object.assign((select) => select({ sessions: {} }), {
        getState: () => ({ sessions: {} }),
      }),
    },
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
    "../lib/providerDiagnostics": { providerLaunchFailureMessage: () => "provider failed" },
    "./AppIcons": {
      IconHelp: "help",
      IconSettings: "settings",
      ZliMark: "mark",
    },
    "./setup/setupModel": model,
    "./setup/SetupProjectStep": { SetupProjectStep: "ProjectStep" },
    "./setup/SetupAgentsStep": { SetupAgentsStep: "AgentsStep" },
    "./setup/SetupReviewStep": { SetupReviewStep: "ReviewStep" },
    "@/components/ui/button": { Button: "button" },
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
  find(render(), "AgentsStep").onSetQuantity("codex", 3);
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
  assert.deepEqual(retired, ["failed-attempt"]);
  assert.equal(completed, 0);
  assert.equal(browserOpened, false);
  partial.onBack();
  const editing = find(render(), "AgentsStep");
  assert.equal(editing.projectLocked, true);
  assert.equal(editing.rows.length, 1);
  editing.onUpdate("draft", { useWorktree: false });
  editing.onContinue();
  const revised = find(render(), "ReviewStep");
  assert.equal(revised.items.filter((item) => item.status === "running").length, 2);
  await revised.onStart();
  assert.deepEqual(
    calls.map((item) => item.name),
    ["Codex 1", "Codex 2", "Codex 3", "Codex 2"],
  );
  assert.equal(calls[3].createWorktree, false);
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

test("normalizes invalid quantities and caps the launch plan at twelve agents", async () => {
  const { clampAgentCount, expandLaunchPlan, plannedAgentCount } =
    await import("../src/components/setup/setupModel.ts");
  for (const value of [NaN, Infinity, -Infinity, 0])
    assert.equal(clampAgentCount(value), 1);
  assert.equal(clampAgentCount(3.9), 3);
  const rows = ["codex", "shell"].map((provider) => ({
    id: provider,
    provider,
    role: "  Worker  ",
    count: 8,
    useWorktree: false,
  }));
  assert.equal(plannedAgentCount(rows), 12);
  const plan = expandLaunchPlan(rows);
  assert.equal(plan.length, 12);
  assert.equal(plan[0].name, "Worker 1");
  assert.equal(plan[7].name, "Worker 8");
  assert.equal(plan[8].provider, "shell");
  assert.equal(plan[11].provider, "shell");
  assert.deepEqual(expandLaunchPlan([]), []);
});

test("clamps agent quantities and totals the launch plan", async () => {
  const { clampAgentCount, plannedAgentCount } =
    await import("../src/components/setup/setupModel.ts");

  assert.equal(clampAgentCount(-2), 1);
  assert.equal(clampAgentCount(3), 3);
  assert.equal(clampAgentCount(12), 12);
  assert.equal(plannedAgentCount([{ count: 2 }, { count: 3 }]), 5);
  assert.equal(plannedAgentCount([{ count: -2 }, { count: 12 }]), 12);
});

test("provider quantities cannot push the global agent total above twelve", async () => {
  const { plannedAgentCount, setProviderQuantity } =
    await import("../src/components/setup/setupModel.ts");
  const rows = [
    { id: "provider-codex", provider: "codex", role: "Codex", count: 8, useWorktree: true },
    { id: "provider-shell", provider: "shell", role: "Shell", count: 3, useWorktree: false },
  ];

  const filled = setProviderQuantity(rows, "shell", 8);
  assert.equal(filled.find((row) => row.provider === "shell").count, 4);
  assert.equal(plannedAgentCount(filled), 12);

  const rejected = setProviderQuantity(filled, "claude", 2);
  assert.equal(rejected.some((row) => row.provider === "claude"), false);
  assert.equal(plannedAgentCount(rejected), 12);
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

test("provider quantities create, update, and remove one launch row per provider", async () => {
  const { setProviderQuantity } = await import(
    "../src/components/setup/setupModel.ts"
  );
  const base = [];
  const withCodex = setProviderQuantity(base, "codex", 3);
  assert.deepEqual(withCodex, [
    {
      id: "provider-codex",
      provider: "codex",
      role: "Codex",
      count: 3,
      useWorktree: true,
    },
  ]);
  const withShell = setProviderQuantity(withCodex, "shell", 2);
  assert.equal(withShell.find((row) => row.provider === "codex").count, 3);
  assert.equal(withShell.find((row) => row.provider === "shell").count, 2);
  const updated = setProviderQuantity(withShell, "codex", 1);
  assert.equal(updated.find((row) => row.provider === "codex").count, 1);
  const removed = setProviderQuantity(updated, "codex", 0);
  assert.deepEqual(removed.map((row) => row.provider), ["shell"]);
});

test("provider cards report installed state and selected quantity", async () => {
  const { providerSelectionState } = await import(
    "../src/components/setup/setupModel.ts"
  );
  const cards = providerSelectionState(
    [
      { id: "codex", displayName: "Codex", executable: "codex", installed: true },
      { id: "claude-code", displayName: "Claude Code", executable: "", installed: false },
    ],
    [{ id: "draft", provider: "codex", role: "Codex", count: 4, useWorktree: true }],
  );
  assert.deepEqual(cards.map(({ id, installed, count, selected }) => ({ id, installed, count, selected })), [
    { id: "codex", installed: true, count: 4, selected: true },
    { id: "claude-code", installed: false, count: 0, selected: false },
  ]);
});

test("workspace entry requires an opened repository", async () => {
  const { canEnterWorkspace } = await import("../src/components/setup/setupModel.ts");
  assert.equal(canEnterWorkspace(null), false);
  assert.equal(canEnterWorkspace({ path: "D:/project" }), true);
});

test("setup avoids bypass and marketing filler", () => {
  const source = readFileSync(new URL("../src/components/SetupWizard.tsx", import.meta.url), "utf8");
  for (const filler of ["Skip for now", "Welcome to Taxzy", "A clear starting point", "One project. Every agent in view."]) {
    assert.doesNotMatch(source, new RegExp(filler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /setup-progress/);
});
