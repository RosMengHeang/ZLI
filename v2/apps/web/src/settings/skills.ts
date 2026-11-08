import {
  AGENT_SKILL_DIRS,
  type FoundSkill,
  type ListedProviderKind,
  PROJECT_SKILLS_DIR,
  ProviderKind,
  type RpcResponse,
  SkillDocument,
  SkillDraft,
  SkillInstallPreview,
  SkillInstallResult,
  SkillListResult,
  type SkillScope,
  type SkillSyncOutcome,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

export type SkillEditorDraft = { name: string; description: string; instructions: string };
export const EMPTY_SKILL_DRAFT: SkillEditorDraft = { name: "", description: "", instructions: "" };

async function request<T>(dispatch: Dispatch, command: Record<string, unknown>, schema: Schema<T>): Promise<T> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const parsed = schema.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply. Restart ZLI and try again.");
  return parsed.data;
}

const context = (projectId: string | undefined) => (projectId ? { projectId } : {});

export function listSkills(dispatch: Dispatch, projectId?: string): Promise<SkillListResult> {
  return request(dispatch, { type: "skills.list", ...context(projectId) }, SkillListResult);
}

export function readSkill(dispatch: Dispatch, scope: SkillScope, name: string): Promise<SkillDocument> {
  return request(dispatch, { type: "skills.read", scope, name }, SkillDocument);
}

export function saveSkill(
  dispatch: Dispatch,
  input: { scope: SkillScope; previousName?: string | undefined; skill: SkillDraft; projectId?: string | undefined },
): Promise<SkillListResult> {
  const { previousName, projectId, ...rest } = input;
  return request(
    dispatch,
    { type: "skills.save", ...rest, ...(previousName ? { previousName } : {}), ...context(projectId) },
    SkillListResult,
  );
}

export function deleteSkill(
  dispatch: Dispatch,
  scope: SkillScope,
  name: string,
  projectId?: string,
): Promise<SkillListResult> {
  return request(dispatch, { type: "skills.delete", scope, name, ...context(projectId) }, SkillListResult);
}

export function setSkillEnabled(
  dispatch: Dispatch,
  name: string,
  enabled: boolean,
  projectId?: string,
): Promise<SkillListResult> {
  return request(dispatch, { type: "skills.setEnabled", name, enabled, ...context(projectId) }, SkillListResult);
}

export function previewSkillInstall(
  dispatch: Dispatch,
  source: string,
  scope: SkillScope,
): Promise<SkillInstallPreview> {
  return request(dispatch, { type: "skills.previewInstall", source, scope }, SkillInstallPreview);
}

export function installSkills(
  dispatch: Dispatch,
  input: { source: string; scope: SkillScope; names: readonly string[]; projectId?: string | undefined },
): Promise<SkillInstallResult> {
  const { projectId, ...rest } = input;
  return request(dispatch, { type: "skills.install", ...rest, ...context(projectId) }, SkillInstallResult);
}

/** The draft as a skill the runtime accepts, or the first problem with it in words a person can act on. */
export function skillFromDraft(draft: SkillEditorDraft): { skill: SkillDraft } | { problem: string } {
  const parsed = SkillDraft.safeParse({
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions,
  });
  if (parsed.success) return { skill: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  const prefix = field === "name" ? "Name: " : field === "description" ? "Description: " : "";
  return { problem: `${prefix}${issue?.message ?? "This skill cannot be saved."}` };
}

export function agentNames(agents: readonly ListedProviderKind[]): string {
  const names = agents.map((agent) => providerDisplayName(agent, undefined));
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** The badge for a skill in an agent's own folder, for example "Found in Claude Code". */
export function foundLabel(skill: Pick<FoundSkill, "agents" | "dir">): string {
  const [first, ...rest] = skill.agents;
  if (!first) return `Found in ${skill.dir}`;
  const name = providerDisplayName(first, undefined);
  return rest.length > 0 ? `Found in ${name} +${rest.length}` : `Found in ${name}`;
}

/** Agents that do not read the project's `.agents/skills`, so its skills do not reach them. */
export function projectSkillGaps(): Array<{ agent: ListedProviderKind; dirs: readonly string[] }> {
  return ProviderKind.options
    .filter((agent) => !AGENT_SKILL_DIRS[agent].project.includes(PROJECT_SKILLS_DIR))
    .map((agent) => ({ agent, dirs: AGENT_SKILL_DIRS[agent].project }));
}

/** Worktree skill folders ZLI could not update, phrased for the person who owns them. */
export function skillSyncProblems(outcomes: readonly SkillSyncOutcome[]): string[] {
  return outcomes.flatMap((outcome) => {
    const lines: string[] = [];
    if (outcome.status === "failed") {
      lines.push(`${outcome.path} could not be updated${outcome.message ? ` (${outcome.message})` : ""}.`);
    }
    for (const name of outcome.conflicts) {
      lines.push(`${outcome.path} already has a skill named ${name}, so ZLI did not copy yours there.`);
    }
    return lines;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type SkillsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: SkillListResult };

export function useSkills(projectId: string | undefined): {
  state: SkillsState;
  reload(): void;
  dispatch: Dispatch;
  apply(work: (dispatch: Dispatch) => Promise<SkillListResult>): Promise<SkillListResult>;
} {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<SkillsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    let cancelled = false;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    listSkills(dispatch, projectId)
      .then((result) => {
        if (!cancelled) setState({ status: "ready", result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, projectId, attempt]);

  const apply = useCallback(
    async (work: (dispatch: Dispatch) => Promise<SkillListResult>) => {
      const result = await work(dispatch);
      setState({ status: "ready", result });
      return result;
    },
    [dispatch],
  );

  return { state, reload: () => setAttempt((value) => value + 1), dispatch, apply };
}
