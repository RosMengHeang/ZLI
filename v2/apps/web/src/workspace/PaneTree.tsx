import { Icon, type IconName } from "../ui/Icon.js";

export type WorkspacePane = "agent" | "terminal" | "browser" | "review";

export const paneLabel: Record<WorkspacePane, string> = {
  agent: "Agent",
  terminal: "Terminal",
  browser: "Browser",
  review: "Review",
};

export const paneIcon: Record<WorkspacePane, IconName> = {
  agent: "sparkle",
  terminal: "terminal",
  browser: "globe",
  review: "diff",
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
      title={candidate === "agent" ? "Agent only" : `Show ${paneLabel[candidate].toLowerCase()} beside the agent`}
    >
      <Icon name={paneIcon[candidate]} size={14} />
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
