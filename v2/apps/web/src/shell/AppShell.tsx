import { WorktreeId } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentPane } from "../agent/AgentPane.js";
import { AttentionPanel } from "../attention/AttentionPanel.js";
import { BrowserPane } from "../browser/BrowserPane.js";
import { ReviewPane } from "../review/ReviewPane.js";
import { getBridge, type ZliBridge } from "../runtime/bridge.js";
import { makeCommandId } from "../runtime/commandId.js";
import { RuntimeProvider, useRuntime } from "../runtime/RuntimeProvider.js";
import { LegacyImportDialog } from "../settings/LegacyImportDialog.js";
import { TerminalPane } from "../terminal/TerminalPane.js";
import { PanelResizer, usePanelWidth } from "../workspace/PanelResizer.js";
import { PaneTree, paneLabel, type WorkspacePane } from "../workspace/PaneTree.js";
import { type WorktreeAction, WorktreeSidebar } from "../worktrees/WorktreeSidebar.js";
import { HelpDialog } from "./HelpDialog.js";
import "./AppShell.css";

export function AppShell({ bridge = getBridge() }: { bridge?: ZliBridge } = {}) {
  return (
    <RuntimeProvider bridge={bridge}>
      <WorkspaceApp />
    </RuntimeProvider>
  );
}

function WorkspaceApp() {
  const { bridge, projection, dispatch } = useRuntime();
  const [activeWorktreeId, setActiveWorktreeId] = useState<string>();
  const [pane, setPane] = useState<WorkspacePane>("agent");
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [legacyImportBatchId, setLegacyImportBatchId] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [version, setVersion] = useState<string>();
  const paletteSearchRef = useRef<HTMLInputElement>(null);
  const activeWorktree = useMemo(
    () => projection?.worktrees.find((worktree) => worktree.worktreeId === activeWorktreeId),
    [activeWorktreeId, projection],
  );

  useEffect(() => {
    const first = projection?.worktrees[0];
    if (!activeWorktreeId && first) setActiveWorktreeId(first.worktreeId);
  }, [activeWorktreeId, projection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteQuery("");
        setActiveCommandIndex(0);
        setPaletteOpen(true);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setPaletteQuery("");
        setWorktreeDialogOpen(false);
        setLegacyImportBatchId(undefined);
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (paletteOpen) paletteSearchRef.current?.focus();
  }, [paletteOpen]);

  const openProject = async () => {
    if (!bridge) {
      setNotice("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const path = await bridge.dialog.openProject();
    if (!path) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "project.register", path },
    });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const exportSupportBundle = async () => {
    if (!bridge) {
      setNotice("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const destinationPath = await bridge.dialog.saveSupportBundle();
    if (!destinationPath) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "diagnostics.createSupportBundle", destinationPath },
    });
    if (response?.accepted === false) setNotice(response.error.message);
    else setNotice("Creating a redacted support bundle...");
  };

  const startLegacyImport = async () => {
    if (!bridge) {
      setNotice("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const snapshotPath = await bridge.dialog.openLegacySnapshot();
    if (!snapshotPath) return;
    const batchId = makeCommandId();
    setLegacyImportBatchId(batchId);
    setPaletteOpen(false);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.scan", batchId, snapshotPath },
    });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const importLegacyRecords = async (selectedRecordIds: string[]) => {
    if (!legacyImportBatchId) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.import", batchId: legacyImportBatchId, selectedRecordIds },
    });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const rollbackLegacyImport = async () => {
    if (!legacyImportBatchId) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.rollbackImport", batchId: legacyImportBatchId },
    });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const bundlePath = projection?.diagnostics?.lastBundle?.path;
  useEffect(() => {
    if (bundlePath) setNotice(`Support bundle saved: ${bundlePath}`);
  }, [bundlePath]);

  useEffect(() => {
    const message = projection?.diagnostics?.lastError;
    if (message) setNotice(`Support bundle failed: ${message}`);
  }, [projection?.diagnostics?.lastError]);

  useEffect(() => {
    if (!helpOpen || !bridge) return;
    void bridge.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion("development"));
  }, [bridge, helpOpen]);

  const worktreeAction = async (worktreeId: string, action: WorktreeAction) => {
    setNotice(undefined);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command:
        action === "remove"
          ? { type: "worktree.remove", worktreeId: WorktreeId.parse(worktreeId) }
          : {
              type: action === "retry" ? "worktree.retry" : "worktree.cancel",
              worktreeId: WorktreeId.parse(worktreeId),
            },
    });
    if (response?.accepted === false) setNotice(response.error.message);
    else if (action === "remove" && worktreeId === activeWorktreeId) setActiveWorktreeId(undefined);
  };

  const createWorktree = async (branch: string, baseRef: string) => {
    const project =
      projection?.projects.find((candidate) => candidate.projectId === activeWorktree?.projectId) ??
      projection?.projects[0];
    if (!project) return;
    const safeBranch = branch
      .trim()
      .replace(/[^a-zA-Z0-9._/-]/gu, "-")
      .replace(/^[-/]+|[-/]+$/gu, "");
    if (!safeBranch) {
      setNotice("Choose a branch name before creating a worktree.");
      return;
    }
    const worktreeId = makeCommandId();
    const workspaceRoot = `${project.path.replace(/[\\/]+$/u, "")}-worktrees`;
    const worktreePath = `${workspaceRoot}/${safeBranch.replace(/[\\/]/gu, "-")}`;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: {
        type: "worktree.create",
        worktreeId,
        projectId: project.projectId,
        path: worktreePath,
        workspaceRoot,
        branch: safeBranch,
        ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
      },
    });
    if (response?.accepted === false) setNotice(response.error.message);
    else setWorktreeDialogOpen(false);
  };

  const choosePane = (next: WorkspacePane) => {
    setPane(next);
    setPaletteOpen(false);
  };
  const commands: PaletteCommand[] = [
    {
      label: "Open project",
      action: () => {
        void openProject();
      },
    },
    {
      label: "Export support bundle",
      action: () => {
        void exportSupportBundle();
      },
    },
    {
      label: "Import legacy snapshot",
      action: () => {
        void startLegacyImport();
      },
    },
    { label: "Help and diagnostics", action: () => setHelpOpen(true) },
    { label: "Focus agent", action: () => choosePane("agent") },
    { label: "Focus terminal", action: () => choosePane("terminal") },
    { label: "Focus browser", action: () => choosePane("browser") },
    { label: "Focus review", action: () => choosePane("review") },
  ];
  const filteredCommands = commands.filter((command) =>
    command.label.toLowerCase().includes(paletteQuery.trim().toLowerCase()),
  );
  const runPaletteCommand = (command: PaletteCommand) => {
    setPaletteOpen(false);
    setPaletteQuery("");
    command.action();
  };
  const handlePaletteKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveCommandIndex((index) => (filteredCommands.length === 0 ? 0 : (index + 1) % filteredCommands.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveCommandIndex((index) =>
        filteredCommands.length === 0 ? 0 : (index - 1 + filteredCommands.length) % filteredCommands.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filteredCommands[activeCommandIndex];
      if (command) runPaletteCommand(command);
    }
  };
  const hasProjects = (projection?.projects.length ?? 0) > 0;
  const overlayOpen =
    paletteOpen || worktreeDialogOpen || helpOpen || (legacyImportBatchId !== undefined && projection !== undefined);

  return (
    <div className="app-shell">
      <WorktreeSidebar
        projection={projection}
        activeWorktreeId={activeWorktreeId}
        onSelect={(worktree) => {
          setActiveWorktreeId(worktree.worktreeId);
          setNotice(undefined);
        }}
        onOpenProject={() => void openProject()}
        onCreateWorktree={() => setWorktreeDialogOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onWorktreeAction={(worktree, action) => void worktreeAction(worktree.worktreeId, action)}
      />
      <main className="main-workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            {activeWorktree ? (
              <>
                <span className="workspace-branch">{activeWorktree.branch}</span>
                <span className="workspace-path" title={activeWorktree.path}>
                  {activeWorktree.path}
                </span>
              </>
            ) : (
              <span className="workspace-branch is-empty">{hasProjects ? "Select a worktree" : "No project open"}</span>
            )}
          </div>
          <PaneTree pane={pane} onChange={setPane} />
          <button className="command-trigger" type="button" onClick={() => setPaletteOpen(true)}>
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
        </header>
        {notice && (
          <div className="notice-bar" role="alert">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(undefined)} aria-label="Dismiss message">
              Dismiss
            </button>
          </div>
        )}
        <AttentionPanel items={projection?.attention ?? []} />
        {!bridge ? (
          <DisconnectedState />
        ) : !projection ? (
          <LoadingState />
        ) : (
          <div className="workspace-body">
            <section className="conversation-column" aria-label="Conversation">
              <AgentPane
                projection={projection}
                worktree={activeWorktree}
                onSelectWorktree={(next) => setActiveWorktreeId(next.worktreeId)}
                onCreateWorktree={() => setWorktreeDialogOpen(true)}
              />
            </section>
            {pane !== "agent" && (
              <>
                <PanelResizer width={panelWidth} onChange={setPanelWidth} />
                <aside className="tool-panel" aria-label={`${paneLabel[pane]} panel`} style={{ width: panelWidth }}>
                  {pane === "terminal" ? (
                    <TerminalPane
                      projection={projection}
                      worktree={activeWorktree}
                      onOpenBrowser={() => choosePane("browser")}
                    />
                  ) : pane === "browser" ? (
                    <BrowserPane worktree={activeWorktree} obscured={overlayOpen} />
                  ) : (
                    <ReviewPane worktree={activeWorktree} />
                  )}
                </aside>
              </>
            )}
          </div>
        )}
      </main>
      {paletteOpen && (
        <div className="palette-backdrop">
          <button
            className="dialog-scrim"
            type="button"
            aria-label="Close command palette"
            onClick={() => setPaletteOpen(false)}
          />
          <section
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="palette-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={paletteSearchRef}
                value={paletteQuery}
                onChange={(event) => {
                  setPaletteQuery(event.target.value);
                  setActiveCommandIndex(0);
                }}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Search commands"
                aria-label="Search commands"
              />
            </div>
            <div className="palette-section">
              <span className="eyebrow">Workspace</span>
              {filteredCommands.length === 0 ? (
                <p className="palette-empty">No matching commands.</p>
              ) : (
                filteredCommands.map((command, index) => (
                  <button
                    className={index === activeCommandIndex ? "is-active" : undefined}
                    type="button"
                    key={command.label}
                    onClick={() => runPaletteCommand(command)}
                  >
                    {command.label}
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}
      {legacyImportBatchId && projection && (
        <LegacyImportDialog
          projection={projection}
          batchId={legacyImportBatchId}
          onImport={(selected) => void importLegacyRecords(selected)}
          onRollback={() => void rollbackLegacyImport()}
          onClose={() => setLegacyImportBatchId(undefined)}
        />
      )}
      {helpOpen && (
        <HelpDialog
          version={version}
          onSupportBundle={() => {
            setHelpOpen(false);
            void exportSupportBundle();
          }}
          onImportLegacy={() => {
            setHelpOpen(false);
            void startLegacyImport();
          }}
          onClose={() => setHelpOpen(false)}
        />
      )}
      {worktreeDialogOpen && (
        <WorktreeDialog
          onClose={() => setWorktreeDialogOpen(false)}
          onSubmit={(branch, baseRef) => void createWorktree(branch, baseRef)}
        />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="center-state">
      <h1>Connecting to the local runtime</h1>
      <p>Projects, worktrees, and sessions appear once the runtime responds.</p>
    </div>
  );
}
function DisconnectedState() {
  return (
    <div className="center-state">
      <h1>Start ZLI from the desktop app</h1>
      <p>
        This window has no runtime bridge. Run <code>pnpm --dir v2 desktop:dev</code> from the repository root.
      </p>
    </div>
  );
}
type PaletteCommand = { label: string; action(): void };
function WorktreeDialog({ onClose, onSubmit }: { onClose(): void; onSubmit(branch: string, baseRef: string): void }) {
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const branchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    branchInputRef.current?.focus();
  }, []);
  return (
    <div className="palette-backdrop">
      <button className="dialog-scrim" type="button" aria-label="Close worktree dialog" onClick={onClose} />
      <section
        className="worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create worktree"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">New worktree</span>
            <h2>Give this workspace a branch</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(branch, baseRef);
          }}
        >
          <label>
            Branch
            <input
              ref={branchInputRef}
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="feature/my-change"
            />
          </label>
          <label>
            Base ref
            <input
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
              placeholder="Current branch (leave empty)"
            />
          </label>
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={!branch.trim()}>
              Create worktree
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
