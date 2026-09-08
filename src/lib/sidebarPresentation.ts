export function projectExpansionAfterSelection(state: {
  active: boolean;
  expanded: boolean;
}): boolean {
  return state.active ? !state.expanded : true;
}

export function projectHoverDetails(input: {
  name: string;
  agentCount: number;
  branch: string;
  path: string;
}) {
  return {
    name: input.name,
    agentLabel: `${input.agentCount} ${input.agentCount === 1 ? "agent" : "agents"}`,
    branch: input.branch,
    path: input.path,
  };
}
