import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { providerDisplayName, type Agent, type TaxChatMessage } from "../types";
import {
  taxChatMessageTone,
  taxChatRecipientLabel,
  taxChatStatusLabel,
  taxChatStatusTone,
  taxChatTimeLabel,
} from "../lib/taxChatPresentation";
import { agentBelongsToProject } from "../lib/workspaceRegistry";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useTaxChatStore } from "../stores/taxChatStore";
import { Button } from "@/components/ui/button";

const TONE_CLASS = {
  accent: "taxchat-tone-accent",
  success: "taxchat-tone-success",
  warning: "taxchat-tone-warning",
  danger: "taxchat-tone-danger",
  muted: "taxchat-tone-muted",
} as const;

function activeAgent(agent: Agent): boolean {
  return agent.status === "running" || agent.status === "starting";
}

function messageSender(message: TaxChatMessage, agents: Agent[]): { label: string; provider?: string } {
  if (message.senderId === "user") return { label: "You" };
  if (message.senderId === "system") return { label: "TaxChat" };
  const agent = agents.find((candidate) => candidate.id === message.senderId);
  return agent
    ? { label: agent.name, provider: agent.provider }
    : { label: "Unavailable agent" };
}

export function TaxChatPanel() {
  const agentMap = useAgentStore((state) => state.agents);
  const project = useProjectStore((state) => state.project);
  const agents = useMemo(() => Object.values(agentMap), [agentMap]);
  const availableAgents = useMemo(
    () => agents.filter((agent) => activeAgent(agent) && (!project || agentBelongsToProject(agent, project))),
    [agents, project],
  );
  const room = useTaxChatStore((state) => state.room);
  const selectedAgentIds = useTaxChatStore((state) => state.selectedAgentIds);
  const setSelectedAgentIds = useTaxChatStore((state) => state.setSelectedAgentIds);
  const start = useTaxChatStore((state) => state.start);
  const pause = useTaxChatStore((state) => state.pause);
  const continueRoom = useTaxChatStore((state) => state.continueRoom);
  const stop = useTaxChatStore((state) => state.stop);
  const send = useTaxChatStore((state) => state.send);
  const reset = useTaxChatStore((state) => state.reset);
  const [draft, setDraft] = useState("");
  const [recipient, setRecipient] = useState("all");
  const transcriptRef = useRef<HTMLDivElement>(null);

  const selectedIds = selectedAgentIds.length
    ? selectedAgentIds
    : availableAgents.map((agent) => agent.id);
  const descriptors = availableAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    terminalId: agent.terminalId,
  }));
  const roomIsRunning = room?.status === "running";

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [room?.messages.length]);

  function toggleAgent(agentId: string): void {
    const current = selectedIds;
    if (current.includes(agentId)) {
      if (current.length === 1) return;
      setSelectedAgentIds(current.filter((id) => id !== agentId));
      return;
    }
    setSelectedAgentIds([...current, agentId]);
  }

  function startRoom(): void {
    if (room?.status === "stopped") reset();
    start(descriptors);
  }

  async function sendMessage(): Promise<void> {
    const body = draft.trim();
    if (!body || !roomIsRunning) return;
    const recipients = recipient === "all"
      ? selectedIds
      : selectedIds.includes(recipient)
        ? [recipient]
        : selectedIds;
    setDraft("");
    await send(body, recipients);
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  const status = room?.status ?? "ready";
  const messageCount = room?.messages.length ?? 0;

  return (
    <section className="taxchat-shell" aria-label="TaxChat">
      <header className="taxchat-header">
        <div className="taxchat-title-row">
          <h2 className="taxchat-title">TaxChat</h2>
        </div>
        <div className="taxchat-meta-row">
          <span className={`taxchat-status ${TONE_CLASS[taxChatStatusTone(status)]}`}>
            <span className="taxchat-status-dot" aria-hidden="true" />
            {taxChatStatusLabel(status)}
          </span>
          <span className="taxchat-meta-copy">
            {room ? `Round ${room.round} · ${messageCount} messages` : "Choose agents, then start a room"}
          </span>
          <div className="taxchat-actions" role="group" aria-label="TaxChat controls">
            {!roomIsRunning && status !== "paused" && status !== "idle" ? (
              <Button type="button" size="sm" className="h-7 px-2.5" onClick={startRoom} disabled={!descriptors.length}>
                Start TaxChat
              </Button>
            ) : null}
            {roomIsRunning ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5" onClick={() => pause()}>
                Pause
              </Button>
            ) : null}
            {status === "paused" || status === "idle" ? (
              <Button type="button" size="sm" className="h-7 px-2.5" onClick={continueRoom}>
                Continue
              </Button>
            ) : null}
            {room && status !== "stopped" ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-danger" onClick={stop}>
                Stop
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="taxchat-participants" aria-label="TaxChat participants">
        <div className="taxchat-section-label">Participants</div>
        <div className="taxchat-participant-list">
          {availableAgents.length ? availableAgents.map((agent) => {
            const selected = selectedIds.includes(agent.id);
            return (
              <Button
                key={agent.id}
                type="button"
                variant="ghost"
                className={`taxchat-participant ${selected ? "is-selected" : ""}`}
                onClick={() => toggleAgent(agent.id)}
                aria-pressed={selected}
                title={`${selected ? "Remove" : "Add"} ${agent.name}`}
              >
                <ProviderIcon provider={agent.provider} size="sm" />
                <span>{agent.name}</span>
                <span className="taxchat-participant-check" aria-hidden="true">{selected ? "✓" : "＋"}</span>
              </Button>
            );
          }) : (
            <span className="taxchat-empty-copy">Launch an agent to add a participant.</span>
          )}
        </div>
      </div>

      <div ref={transcriptRef} className="taxchat-transcript" aria-live="polite" aria-label="TaxChat transcript">
        {!room ? (
          <div className="taxchat-empty-state">
            <div className="taxchat-empty-mark" aria-hidden="true">TC</div>
            <h3>Coordinate the team in one room</h3>
            <p>Ask the selected agents a question. They can send findings to each other when collaboration helps.</p>
            <span>Messages stay inside the local terminal sessions.</span>
          </div>
        ) : room.messages.length === 0 ? (
          <div className="taxchat-empty-state compact">
            <h3>TaxChat is ready</h3>
            <p>Send a prompt to start the shared conversation.</p>
          </div>
        ) : (
          <div className="taxchat-message-list">
            {room.messages.map((message) => {
              const sender = messageSender(message, agents);
              const tone = TONE_CLASS[taxChatMessageTone(message)];
              return (
                <article key={message.id} className={`taxchat-message ${tone} taxchat-message-${message.kind}`}>
                  <div className="taxchat-message-rail" aria-hidden="true" />
                  <div className="taxchat-message-content">
                    <div className="taxchat-message-head">
                      <div className="taxchat-message-sender">
                        {sender.provider ? <ProviderIcon provider={sender.provider} size="sm" /> : <span className="taxchat-avatar" aria-hidden="true">{message.senderId === "user" ? "Y" : "·"}</span>}
                        <span>{sender.label}</span>
                        {sender.provider ? <span className="taxchat-provider">{providerDisplayName(sender.provider)}</span> : null}
                      </div>
                      <time dateTime={message.createdAt}>{taxChatTimeLabel(message.createdAt)}</time>
                    </div>
                    <p className="taxchat-message-body">{message.body}</p>
                    {message.recipientIds.length ? (
                      <div className="taxchat-message-footer">
                        <span>To {taxChatRecipientLabel(message.recipientIds, agents)}</span>
                        <span>{message.status}</span>
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <footer className="taxchat-composer">
        <div className="taxchat-composer-row">
          <label className="sr-only" htmlFor="taxchat-recipient">Send to</label>
          <select
            id="taxchat-recipient"
            className="taxchat-recipient-select"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            disabled={!roomIsRunning || !selectedIds.length}
            aria-label="TaxChat recipient"
          >
            <option value="all">All selected agents</option>
            {availableAgents.filter((agent) => selectedIds.includes(agent.id)).map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          <span className="taxchat-composer-hint">Enter to send · Shift+Enter for a new line</span>
        </div>
        <div className="taxchat-composer-input-row">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={roomIsRunning ? "Ask the team anything…" : "Start TaxChat to send a message"}
            disabled={!roomIsRunning}
            rows={3}
            aria-label="TaxChat message"
          />
          <Button type="button" className="taxchat-send-button" onClick={() => void sendMessage()} disabled={!roomIsRunning || !draft.trim()}>
            Send
          </Button>
        </div>
      </footer>
    </section>
  );
}
