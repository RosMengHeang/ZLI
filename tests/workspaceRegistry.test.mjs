import assert from "node:assert/strict";
import test from "node:test";

const project = (root, name = root) => ({
  path: root,
  name,
  repositoryRoot: root,
  currentBranch: "main",
  baseBranch: "main",
  detachedHead: false,
  clean: true,
});

test("remembers projects, expansion state, and agent launch recipes", async () => {
  const {
    DEFAULT_WORKSPACE_REGISTRY,
    agentBelongsToProject,
    forgetWorkspaceAgent,
    saveWorkspaceAgent,
    setWorkspaceCollapsed,
    toggleWorkspaceExpanded,
    upsertWorkspace,
  } = await import("../src/lib/workspaceRegistry.ts");

  let registry = upsertWorkspace(DEFAULT_WORKSPACE_REGISTRY, project("D:/taxzy", "Taxzy"));
  registry = saveWorkspaceAgent(registry, "D:/taxzy", {
    resumeId: "resume-1",
    name: "Codex 1",
    provider: "codex",
    createWorktree: true,
  });
  registry = upsertWorkspace(registry, project("D:/other", "Other"));
  registry = toggleWorkspaceExpanded(registry, "D:/taxzy");
  registry = setWorkspaceCollapsed(registry, true);

  assert.equal(registry.activeProjectRoot, "D:/other");
  assert.equal(registry.collapsed, true);
  assert.equal(registry.expandedProjectRoots.includes("D:/taxzy"), false);
  assert.deepEqual(registry.workspaces[0].agents, [{
    resumeId: "resume-1",
    name: "Codex 1",
    provider: "codex",
    createWorktree: true,
  }]);

  registry = forgetWorkspaceAgent(registry, "D:/taxzy", "resume-1");
  assert.deepEqual(registry.workspaces[0].agents, []);
  assert.equal(agentBelongsToProject?.({ cwd: "D:/taxzy", projectRoot: "D:/taxzy" }, project("D:/taxzy")), true);
  assert.equal(agentBelongsToProject?.({ cwd: "D:/other" }, project("D:/taxzy")), false);
});

test("removes selected offline agent recipes without affecting active recipes", async () => {
  const {
    DEFAULT_WORKSPACE_REGISTRY,
    forgetWorkspaceAgents,
    saveWorkspaceAgent,
    upsertWorkspace,
  } = await import("../src/lib/workspaceRegistry.ts");

  let registry = upsertWorkspace(DEFAULT_WORKSPACE_REGISTRY, project("D:/taxzy", "Taxzy"));
  for (const resumeId of ["offline-1", "active-1", "offline-2"]) {
    registry = saveWorkspaceAgent(registry, "D:/taxzy", {
      resumeId,
      name: resumeId,
      provider: "codex",
      createWorktree: true,
    });
  }

  registry = forgetWorkspaceAgents(registry, "D:/taxzy", ["offline-1", "offline-2"]);

  assert.deepEqual(
    registry.workspaces[0].agents.map((agent) => agent.resumeId),
    ["active-1"],
  );
});
