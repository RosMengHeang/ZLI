export type WorkspacePane = "agent" | "terminal" | "browser" | "review";

export const paneLabel: Record<WorkspacePane, string> = {
  agent: "Agent",
  terminal: "Terminal",
  browser: "Browser",
  review: "Review",
};

const toolPanes = ["terminal", "browser", "review"] as const;

type Props = {
  pane: WorkspacePane;
  onChange(pane: WorkspacePane): void;
};

export function PaneTree({ pane, onChange }: Props) {
  const tab = (candidate: WorkspacePane) => (
    <button
      className={`pane-tab${pane === candidate ? " is-active" : ""}`}
      key={candidate}
      type="button"
      aria-pressed={pane === candidate}
      onClick={() => onChange(candidate)}
    >
      {paneLabel[candidate]}
    </button>
  );
  return (
    <nav className="pane-tabs" aria-label="Workspace tools">
      {tab("agent")}
      <span className="pane-tabs-divider" aria-hidden="true" />
      {toolPanes.map(tab)}
    </nav>
  );
}
