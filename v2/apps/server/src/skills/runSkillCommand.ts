import type { ProjectId, SkillCommand, SkillScope } from "@zli-v2/contracts";

import { SkillError } from "./skillFolders.js";
import type { ProjectRef, ResolvedSkillScope, SkillStore } from "./SkillStore.js";

/** Answers one skills command. Project ids are resolved to folders through `projectPath`. */
export async function runSkillCommand(
  store: SkillStore,
  command: SkillCommand,
  projectPath: (projectId: ProjectId) => Promise<string | undefined>,
): Promise<unknown> {
  const project = async (projectId: ProjectId): Promise<ProjectRef> => {
    const path = await projectPath(projectId);
    if (!path) throw new SkillError("Project does not exist.");
    return { projectId, path };
  };
  const resolve = async (scope: SkillScope): Promise<ResolvedSkillScope> =>
    scope.kind === "project" ? { kind: "project", project: await project(scope.projectId) } : { kind: "user" };
  /** Lists the project the client asked for, or else the one the command changed. */
  const listed = async (changed?: ResolvedSkillScope) => {
    const projectId = "projectId" in command ? command.projectId : undefined;
    if (projectId) return store.list(await project(projectId));
    return store.list(changed?.kind === "project" ? changed.project : undefined);
  };
  switch (command.type) {
    case "skills.list":
      return listed();
    case "skills.read":
      return store.read(await resolve(command.scope), command.name);
    case "skills.save": {
      const scope = await resolve(command.scope);
      await store.save(scope, command.previousName, command.skill);
      return listed(scope);
    }
    case "skills.delete": {
      const scope = await resolve(command.scope);
      await store.delete(scope, command.name);
      return listed(scope);
    }
    case "skills.setEnabled":
      await store.setEnabled(command.name, command.enabled);
      return listed();
    case "skills.previewInstall":
      return store.previewInstall(command.source, command.scope ? await resolve(command.scope) : undefined);
    case "skills.install": {
      const scope = await resolve(command.scope);
      const installed = await store.install(command.source, scope, command.names);
      return { ...(await listed(scope)), installed };
    }
  }
}
