import { newId } from "./ids.ts";
import {
  consumeTaxChatChunk,
  formatTaxChatDelivery,
  type TaxChatParserState,
} from "./taxChatProtocol.ts";
import type {
  TaxChatMessage,
  TaxChatParticipant,
  TaxChatRoomStatus,
  TaxChatRoomSettings,
} from "../types";

export interface TaxChatAgentDescriptor {
  id: string;
  name: string;
  provider: string;
  terminalId: string;
}

export interface TaxChatTransport {
  write: (terminalId: string, data: string) => Promise<void>;
}

export type TaxChatCoordinatorEvent =
  | { type: "message"; message: TaxChatMessage }
  | { type: "status"; status: TaxChatRoomStatus; reason?: string }
  | { type: "participant"; participant: TaxChatParticipant }
  | { type: "error"; message: TaxChatMessage };

export interface TaxChatCoordinatorOptions {
  agents: TaxChatAgentDescriptor[];
  settings: TaxChatRoomSettings;
  transport: TaxChatTransport;
  onEvent: (event: TaxChatCoordinatorEvent) => void;
}

export interface TaxChatCoordinator {
  start(): void;
  pause(reason?: string): void;
  continue(): void;
  stop(): void;
  sendUserMessage(body: string, recipientIds: string[]): Promise<void>;
  handleOutput(agentId: string, chunk: string): void;
  handleAgentExit(agentId: string): void;
  recordExternalMessage(message: TaxChatMessage): void;
  snapshot(): {
    status: TaxChatRoomStatus;
    round: number;
    participants: TaxChatParticipant[];
    messages: TaxChatMessage[];
  };
  dispose(): void;
}

const EMPTY_SETTINGS: TaxChatRoomSettings = {
  inactivityMs: 45_000,
  perAgentMessageLimit: 8,
  totalMessageLimit: 64,
};

function normalizeSettings(settings: TaxChatRoomSettings): TaxChatRoomSettings {
  return {
    inactivityMs: Math.max(1, settings.inactivityMs || EMPTY_SETTINGS.inactivityMs),
    perAgentMessageLimit: Math.max(1, settings.perAgentMessageLimit || EMPTY_SETTINGS.perAgentMessageLimit),
    totalMessageLimit: Math.max(1, settings.totalMessageLimit || EMPTY_SETTINGS.totalMessageLimit),
  };
}

export function createTaxChatCoordinator(options: TaxChatCoordinatorOptions): TaxChatCoordinator {
  const settings = normalizeSettings(options.settings);
  const agentMap = new Map(options.agents.map((agent) => [agent.id, agent]));
  const participantMap = new Map<string, TaxChatParticipant>(
    options.agents.map((agent) => [
      agent.id,
      {
        agentId: agent.id,
        status: "available",
        routedCount: 0,
      },
    ]),
  );
  const parserStates = new Map<string, TaxChatParserState>();
  const queues = new Map<string, Promise<void>>();
  let status: TaxChatRoomStatus = "ready";
  let round = 1;
  let totalRouted = 0;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const messages: TaxChatMessage[] = [];

  function emit(event: TaxChatCoordinatorEvent): void {
    if (!disposed) options.onEvent(event);
  }

  function clearInactivityTimer(): void {
    if (!inactivityTimer) return;
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }

  function scheduleIdle(): void {
    clearInactivityTimer();
    if (status !== "running") return;
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null;
      if (status === "running") setStatus("idle", "No new TaxChat messages.");
    }, settings.inactivityMs);
    const nodeTimer = inactivityTimer as unknown as { unref?: () => void };
    nodeTimer.unref?.();
  }

  function setStatus(next: TaxChatRoomStatus, reason?: string): void {
    if (status === next && !reason) return;
    status = next;
    if (next !== "running") clearInactivityTimer();
    emit({ type: "status", status: next, reason });
  }

  function appendMessage(
    input: Omit<TaxChatMessage, "id" | "createdAt" | "round">,
  ): TaxChatMessage {
    const message: TaxChatMessage = {
      ...input,
      id: newId(),
      createdAt: new Date().toISOString(),
      round,
    };
    messages.push(message);
    emit({ type: "message", message });
    return message;
  }

  function appendSystem(body: string, kind: "system" | "error" = "system"): TaxChatMessage {
    const message = appendMessage({
      senderId: "system",
      recipientIds: [],
      kind,
      body,
      status: kind === "error" ? "failed" : "informational",
    });
    if (kind === "error") emit({ type: "error", message });
    return message;
  }

  function updateParticipant(agentId: string, update: Partial<TaxChatParticipant>): void {
    const current = participantMap.get(agentId);
    if (!current) return;
    const participant = { ...current, ...update };
    participantMap.set(agentId, participant);
    emit({ type: "participant", participant });
  }

  function availableRecipientIds(recipient: string, senderId?: string): string[] {
    if (recipient === "user") return ["user"];
    const candidates = recipient === "all" ? [...agentMap.keys()] : [recipient];
    return candidates.filter((agentId) => {
      if (agentId === senderId) return false;
      const participant = participantMap.get(agentId);
      return Boolean(participant && participant.status !== "unavailable");
    });
  }

  function transcriptWith(body: string, senderName: string): string {
    const history = messages.slice(-24).map((message) => `${message.senderId}: ${message.body}`);
    history.push(`${senderName}: ${body}`);
    return history.join("\n");
  }

  function pauseAtLimit(reason: string): void {
    appendSystem(reason);
    setStatus("paused", reason);
  }

  function canRoute(agentId: string): boolean {
    const participant = participantMap.get(agentId);
    if (!participant || participant.status === "unavailable") return false;
    if (participant.routedCount >= settings.perAgentMessageLimit) {
      pauseAtLimit(`TaxChat paused: ${agentId} reached its per-agent message limit.`);
      return false;
    }
    if (totalRouted >= settings.totalMessageLimit) {
      pauseAtLimit("TaxChat paused: the room reached its message limit.");
      return false;
    }
    return true;
  }

  function enqueue(agentId: string, senderName: string, senderId: string, recipientIds: string[], body: string): Promise<void> {
    const agent = agentMap.get(agentId);
    if (!agent) return Promise.resolve();
    const run = async () => {
      if (disposed || status === "stopped" || status === "paused") return;
      updateParticipant(agentId, { status: "delivering" });
      try {
        await options.transport.write(
          agent.terminalId,
          `${formatTaxChatDelivery({
            senderName,
            senderId,
            recipientIds,
            transcript: transcriptWith(body, senderName),
          })}\r`,
        );
        if (participantMap.get(agentId)?.status !== "unavailable") {
          updateParticipant(agentId, { status: "available" });
        }
        appendMessage({
          senderId: "system",
          recipientIds: [agentId],
          kind: "delivery",
          body: `Delivered to ${agent.name}.`,
          status: "delivered",
        });
        scheduleIdle();
      } catch (error) {
        updateParticipant(agentId, { status: "available" });
        appendSystem(`Could not deliver TaxChat message to ${agent.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };
    const previous = queues.get(agentId);
    const write = previous ? previous.then(run) : run();
    queues.set(agentId, write.catch(() => undefined));
    return write;
  }

  function routeBlock(senderId: string, recipient: string, body: string): void {
    if (recipient === "user") {
      appendMessage({
        senderId,
        recipientIds: ["user"],
        kind: "agent",
        body,
        status: "delivered",
      });
      scheduleIdle();
      return;
    }
    const recipientIds = availableRecipientIds(recipient, senderId);
    if (!recipientIds.length) {
      return;
    }

    const routedIds = recipientIds.filter((recipientId) => canRoute(recipientId));
    if (!routedIds.length || status !== "running") return;
    const sender = agentMap.get(senderId);
    appendMessage({
      senderId,
      recipientIds: routedIds,
      kind: "agent",
      body,
      status: "pending",
    });
    totalRouted += routedIds.length;
    for (const recipientId of routedIds) {
      const participant = participantMap.get(recipientId);
      updateParticipant(recipientId, {
        status: "queued",
        routedCount: (participant?.routedCount ?? 0) + 1,
      });
      void enqueue(recipientId, sender?.name ?? senderId, senderId, routedIds, body);
    }
    scheduleIdle();
    if (totalRouted >= settings.totalMessageLimit) {
      pauseAtLimit("TaxChat paused: the room reached its message limit.");
    }
  }

  return {
    start: () => {
      if (disposed || status === "running" || status === "stopped") return;
      setStatus("running");
      scheduleIdle();
    },

    pause: (reason = "Paused by user.") => {
      if (disposed || status === "stopped") return;
      setStatus("paused", reason);
      appendSystem(`TaxChat paused. ${reason}`);
    },

    continue: () => {
      if (disposed || status === "stopped") return;
      if (status === "ready") {
        setStatus("running");
      } else {
        round += 1;
        totalRouted = 0;
        for (const [agentId, participant] of participantMap) {
          participantMap.set(agentId, { ...participant, routedCount: 0 });
        }
        setStatus("running", "Continuing TaxChat.");
      }
      scheduleIdle();
    },

    stop: () => {
      if (disposed || status === "stopped") return;
      queues.clear();
      setStatus("stopped", "Stopped by user.");
      appendSystem("TaxChat stopped. Terminal sessions remain running.");
    },

    sendUserMessage: async (body, recipientIds) => {
      const text = body.trim();
      if (!text || disposed || status !== "running") return;
      const validRecipients = recipientIds.filter((id) => participantMap.has(id) && participantMap.get(id)?.status !== "unavailable");
      if (!validRecipients.length) {
        appendSystem("Choose at least one available agent before sending a TaxChat message.", "error");
        return;
      }
      appendMessage({
        senderId: "user",
        recipientIds: validRecipients,
        kind: "user",
        body: text,
        status: "delivered",
      });
      scheduleIdle();
      await Promise.all(validRecipients.map((agentId) => {
        const participant = participantMap.get(agentId);
        updateParticipant(agentId, {
          status: "queued",
          routedCount: participant?.routedCount ?? 0,
        });
        return enqueue(agentId, "You", "user", validRecipients, text);
      }));
    },

    handleOutput: (agentId, chunk) => {
      if (disposed || status !== "running" || !agentMap.has(agentId)) return;
      const state = parserStates.get(agentId) ?? { buffer: "" };
      const result = consumeTaxChatChunk(state, agentId, chunk);
      parserStates.set(agentId, result.state);
      for (const block of result.blocks) routeBlock(block.senderId, block.recipient, block.body);
    },

    handleAgentExit: (agentId) => {
      if (!participantMap.has(agentId)) return;
      updateParticipant(agentId, { status: "unavailable" });
      appendSystem(`${agentMap.get(agentId)?.name ?? agentId} is unavailable.`);
      if ([...participantMap.values()].every((participant) => participant.status === "unavailable")) {
        setStatus("paused", "No TaxChat participants remain available.");
      }
    },

    recordExternalMessage: (message) => {
      if (disposed) return;
      const existingIndex = messages.findIndex((candidate) => candidate.id === message.id);
      if (existingIndex >= 0) {
        const existing = messages[existingIndex];
        const updated = {
          ...existing,
          ...message,
          recipientIds: [...message.recipientIds],
        };
        messages[existingIndex] = updated;
        emit({ type: "message", message: updated });
        scheduleIdle();
        return;
      }
      const copy = { ...message, recipientIds: [...message.recipientIds] };
      messages.push(copy);
      emit({ type: "message", message: copy });
      scheduleIdle();
    },

    snapshot: () => ({
      status,
      round,
      participants: [...participantMap.values()].map((participant) => ({ ...participant })),
      messages: messages.map((message) => ({ ...message, recipientIds: [...message.recipientIds] })),
    }),

    dispose: () => {
      disposed = true;
      clearInactivityTimer();
      queues.clear();
      parserStates.clear();
    },
  };
}
