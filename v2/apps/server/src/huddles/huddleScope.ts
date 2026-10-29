import {
  type AgentToolScope,
  huddleSpansProjects,
  type RuntimeCommand,
  type RuntimeProjection,
} from "@zli-v2/contracts";

/**
 * A huddle with agents from more than one project lets them read each other's work, so it needs the
 * same Settings switch as agents reaching other projects. Returns why the command is refused, if it is.
 */
export function huddleScopeError(
  projection: RuntimeProjection,
  command: RuntimeCommand,
  scope: AgentToolScope,
): string | undefined {
  if (scope === "all") return undefined;
  let members: string[];
  if (command.type === "huddle.create") members = command.members ?? [];
  else if (command.type === "huddle.join") {
    const huddle = projection.huddles?.find((candidate) => candidate.huddleId === command.huddleId);
    if (!huddle) return undefined;
    members = [...huddle.members.map((member) => member.agentId), command.agentId];
  } else return undefined;
  if (!huddleSpansProjects(projection, members)) return undefined;
  return "This would put agents from more than one project in the huddle. In Settings, under Integrations, set Which agents they can reach to In every project first.";
}
