import { useEffect, useMemo, useState } from "react";

import type { WorktreeProjection } from "@zli-v2/contracts";
import { AttentionPanel } from "../attention/AttentionPanel.js";
import { BrowserPane } from "../browser/BrowserPane.js";
import { RuntimeProvider, useRuntime } from "../runtime/RuntimeProvider.js";
import { ReviewPane } from "../review/ReviewPane.js";
import { TerminalPane } from "../terminal/TerminalPane.js";
import { WorktreeSidebar } from "../worktrees/WorktreeSidebar.js";
import { PaneTree, type WorkspacePane } from "../workspace/PaneTree.js";
import { getBridge, type ZliBridge } from "../runtime/bridge.js";
import "./AppShell.css";

export function AppShell({ bridge = getBridge() }: { bridge?: ZliBridge } = {}) {
  return <RuntimeProvider bridge={bridge}><WorkspaceApp /></RuntimeProvider>;
}

function WorkspaceApp() {
  const { bridge, projection, connected, dispatch } = useRuntime();
  const [activeWorktreeId, setActiveWorktreeId] = useState<string>();
  const [pane, setPane] = useState<WorkspacePane>("terminal");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const activeWorktree = useMemo(() => projection?.worktrees.find((worktree) => worktree.worktreeId === activeWorktreeId), [activeWorktreeId, projection]);

  useEffect(() => {
    const first = projection?.worktrees[0];
    if (!activeWorktreeId && first) setActiveWorktreeId(first.worktreeId);
  }, [activeWorktreeId, projection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openProject = async () => {
    if (!bridge) { setNotice("The desktop bridge is unavailable. Start ZLI from Electron."); return; }
    const path = await bridge.dialog.openProject();
    if (!path) return;
    const response = await dispatch({ protocolVersion: 1, commandId: makeId(), command: { type: "project.register", path } });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const choosePane = (next: WorkspacePane) => { setPane(next); setPaletteOpen(false); };
  const worktreeLabel = activeWorktree?.branch ?? "No worktree selected";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand"><span className="brand-mark">Z</span><span className="brand-name">ZLI</span><span className="brand-divider" aria-hidden="true" /> <span className="context-name">{worktreeLabel}</span></div>
        <button className="command-trigger" type="button" onClick={() => setPaletteOpen(true)}><span>Jump to anything</span><kbd>Ctrl K</kbd></button>
        <div className="topbar-actions"><span className={`runtime-state${connected ? " is-connected" : ""}`}><span className="status-dot" aria-hidden="true" />{connected ? "Connected" : bridge ? "Connecting" : "Desktop only"}</span><button className="icon-button" type="button" onClick={() => void bridge?.app.quit()} aria-label="Quit ZLI">×</button></div>
      </header>
      <div className="app-body">
        <WorktreeSidebar projection={projection} activeWorktreeId={activeWorktreeId} onSelect={(worktree) => { setActiveWorktreeId(worktree.worktreeId); setNotice(undefined); }} onOpenProject={() => void openProject()} />
        <main className="main-workspace">
          {notice && <div className="notice-bar" role="alert">{notice}<button type="button" onClick={() => setNotice(undefined)} aria-label="Dismiss message">Dismiss</button></div>}
          <AttentionPanel items={projection?.attention ?? []} />
          {!bridge ? <DisconnectedState /> : !projection ? <LoadingState /> : <PaneTree pane={pane} onChange={setPane}>{pane === "terminal" ? <TerminalPane projection={projection} worktree={activeWorktree} onOpenBrowser={() => choosePane("browser")} /> : pane === "browser" ? <BrowserPane worktree={activeWorktree} /> : <ReviewPane worktree={activeWorktree} />}</PaneTree>}
        </main>
      </div>
      {paletteOpen && <div className="palette-backdrop" role="presentation" onMouseDown={() => setPaletteOpen(false)}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}><div className="palette-search"><span aria-hidden="true">⌕</span><input autoFocus placeholder="Search commands" aria-label="Search commands" /></div><div className="palette-section"><span className="eyebrow">Workspace</span><button type="button" onClick={() => void openProject()}>Open project</button><button type="button" onClick={() => choosePane("terminal")}>Focus terminal</button><button type="button" onClick={() => choosePane("browser")}>Focus browser</button><button type="button" onClick={() => choosePane("review")}>Focus review</button></div></section></div>}
    </div>
  );
}

function LoadingState() { return <div className="center-state"><span className="eyebrow">Runtime</span><h1>Connecting to your workspace</h1><p>The local environment is restoring projects, worktrees, and sessions.</p></div>; }
function DisconnectedState() { return <div className="center-state"><span className="eyebrow">Desktop shell</span><h1>Start ZLI from Electron</h1><p>This renderer is intentionally isolated from Node and the filesystem. The desktop shell provides the local runtime bridge.</p></div>; }
function makeId(): string { return globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000999"; }
