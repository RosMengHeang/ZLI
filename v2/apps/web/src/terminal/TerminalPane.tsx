import { useEffect, useRef, useState } from "react";

import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Props = { projection: RuntimeProjection | undefined; worktree: WorktreeProjection | undefined; onOpenBrowser(): void };

export function TerminalPane({ projection, worktree, onOpenBrowser }: Props) {
  const { bridge, dispatch } = useRuntime();
  const terminal = projection?.terminals.find((candidate) => candidate.worktreeId === worktree?.worktreeId);
  const [output, setOutput] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lastSequence = useRef(0);

  useEffect(() => {
    if (!bridge || !terminal) return;
    let active = true;
    let snapshotReceived = false;
    const unsubscribe = bridge.runtime.onTerminal((message) => {
      if (!active) return;
      if (message.kind === "snapshot" && message.snapshot.terminalId === terminal.terminalId) {
        snapshotReceived = true;
        setOutput(message.snapshot.chunks.map((chunk) => decodeChunk(chunk.bytesBase64)).join(""));
        lastSequence.current = message.snapshot.nextSequence;
      } else if (message.kind === "stream") {
        const stream = message.message;
        const streamTerminalId = stream.kind === "chunk" ? stream.chunk.terminalId : stream.terminalId;
        if (streamTerminalId !== terminal.terminalId) return;
        if (stream.kind === "chunk") {
          setOutput((current) => `${current}${decodeChunk(stream.chunk.bytesBase64)}`.slice(-200_000));
          lastSequence.current = stream.chunk.sequence;
        } else if (stream.kind === "exit") {
          setOutput((current) => `${current}\n[process exited: ${stream.code}]\n`);
        }
      }
    });
    const attach = async () => {
      for (let attempt = 0; attempt < 30 && active && !snapshotReceived; attempt += 1) {
        try {
          await bridge.runtime.attachTerminal(terminal.terminalId, lastSequence.current);
        } catch {
          // The terminal can still be starting or the runtime can be reconnecting.
        }
        if (snapshotReceived) return;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000, 100 * 2 ** attempt)));
      }
    };
    void attach();
    return () => { active = false; unsubscribe(); };
  }, [bridge, terminal?.terminalId]);

  const createTerminal = async () => {
    if (!worktree) return;
    setBusy(true); setError(undefined);
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeId(), command: { type: "terminal.create", terminalId: makeId(), worktreeId: worktree.worktreeId, cwd: worktree.path, shell: shellForPlatform(), title: `${worktree.branch} terminal`, cols: 120, rows: 32 } });
      if (response?.accepted === false) setError(response.error.message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The terminal could not start."); }
    finally { setBusy(false); }
  };

  const write = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!terminal || !draft) return;
    setError(undefined);
    const response = await dispatch({ protocolVersion: 1, commandId: makeId(), command: { type: "terminal.write", terminalId: terminal.terminalId, data: `${draft}\r` } });
    if (response?.accepted === false) setError(response.error.message); else setDraft("");
  };

  return (
    <div className="tool-pane terminal-pane">
      <div className="tool-pane-header"><div><span className="eyebrow">Terminal</span><h2>{worktree?.branch ?? "No worktree selected"}</h2></div><span className="pane-meta">{terminal ? terminal.status : "Idle"}</span></div>
      {!worktree ? <EmptyPane title="Select a worktree" detail="Terminal sessions belong to a worktree, so there is nothing to attach yet." /> : terminal ? <><pre className="terminal-output" role="log" aria-label="Terminal output">{output || <span className="terminal-muted">Terminal session connected. Type a command below.</span>}</pre><form className="terminal-input-row" onSubmit={(event) => void write(event)}><span className="terminal-prompt" aria-hidden="true">›</span><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type a command" aria-label="Terminal command" /><button className="secondary-button" type="submit" disabled={!draft || terminal.status !== "running"}>Send</button></form>{terminal.errorMessage && <p className="inline-error" role="alert">{terminal.errorMessage}</p>}{error && <p className="inline-error" role="alert">{error}</p>}</> : <div className="empty-pane"><p className="empty-title">No terminal session</p><p className="empty-detail">Start a real PTY attached to this worktree, or open the Chromium workspace.</p><div className="empty-actions"><button className="primary-button" type="button" onClick={() => void createTerminal()} disabled={busy}>{busy ? "Starting" : "Start terminal"}</button><button className="secondary-button" type="button" onClick={onOpenBrowser}>Open browser</button></div>{error && <p className="inline-error" role="alert">{error}</p>}</div>}
    </div>
  );
}

function EmptyPane({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-pane"><p className="empty-title">{title}</p><p className="empty-detail">{detail}</p></div>;
}

function decodeChunk(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function shellForPlatform(): string {
  return navigator.userAgent.includes("Windows") ? "powershell.exe" : "/bin/bash";
}

function makeId(): string { return globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000997"; }
