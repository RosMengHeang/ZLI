import type { ReactNode } from "react";

export type WorkspacePane = "agent" | "terminal" | "browser" | "review";

type Props = {
  pane: WorkspacePane;
  onChange(pane: WorkspacePane): void;
  children: ReactNode;
};

export function PaneTree({ pane, onChange, children }: Props) {
  return (
    <section className="workspace-surface" aria-label="Workspace">
      <nav className="pane-tabs" aria-label="Workspace tools">
        {(["agent", "terminal", "browser", "review"] as const).map((candidate) => (
          <button
            className={`pane-tab${pane === candidate ? " is-active" : ""}`}
            key={candidate}
            type="button"
            onClick={() => onChange(candidate)}
          >
            {candidate[0]!.toUpperCase() + candidate.slice(1)}
          </button>
        ))}
      </nav>
      <div className="pane-content">{children}</div>
    </section>
  );
}
