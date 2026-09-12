import { create } from "zustand";
import {
  createTaxChatCoordinator,
  type TaxChatAgentDescriptor,
  type TaxChatCoordinator,
  type TaxChatCoordinatorSnapshot,
  type TaxChatTransport,
} from "../lib/taxChatCoordinator.ts";
import { newId } from "../lib/ids.ts";
import type { TaxChatMessageStatus, TaxChatRoom, TaxChatRoomSettings } from "../types";
import type { PtyLifecycleEvent } from "../lib/ptyEventFanout.ts";
import type { AgentEventEnvelope, AgentEventPayload } from "../lib/agentEvents.ts";

export interface TaxChatPtyBridge {
  subscribePtyOutput: (listener: (terminalId: string, data: string) => void) => () => void;
  subscribePtyLifecycle: (listener: (event: PtyLifecycleEvent) => void) => () => void;
}

export interface TaxChatRuntime {
  projectId: string | null;
  transport: TaxChatTransport;
  bridge: TaxChatPtyBridge | null;
}

export interface TaxChatState {
  room: TaxChatRoom | null;
  settings: TaxChatRoomSettings;
  selectedAgentIds: string[];
  start: (agents: TaxChatAgentDescriptor[]) => void;
  pause: (reason?: string) => void;
  continueRoom: () => void;
  stop: () => void;
  send: (body: string, recipientIds: string[]) => Promise<void>;
  setSelectedAgentIds: (ids: string[]) => void;
  applyEvent: (event: AgentEventEnvelope) => void;
  restore: (room: TaxChatRoom, agents: TaxChatAgentDescriptor[]) => void;
  reset: () => void;
}

export const DEFAULT_TAX_CHAT_SETTINGS: TaxChatRoomSettings = {
  inactivityMs: 45_000,
  perAgentMessageLimit: 8,
  totalMessageLimit: 64,
};

let runtime: TaxChatRuntime = {
  projectId: null,
  transport: {
    send: async () => {
      throw new Error("TaxChat transport is not configured.");
    },
  },
  bridge: null,
};
let coordinator: TaxChatCoordinator | null = null;
let roomId: string | null = null;
let unsubscribeOutput: (() => void) | null = null;
let unsubscribeLifecycle: (() => void) | null = null;

export function configureTaxChatRuntime(next: Partial<TaxChatRuntime>): void {
  runtime = { ...runtime, ...next };
}

function detachRuntime(): void {
  unsubscribeOutput?.();
  unsubscribeLifecycle?.();
  unsubscribeOutput = null;
  unsubscribeLifecycle = null;
}

function snapshotRoom(nextCoordinator: TaxChatCoordinator): TaxChatRoom {
  const snapshot = nextCoordinator.snapshot();
  return {
    id: roomId ?? newId(),
    status: snapshot.status,
    participantIds: snapshot.participants.map((participant) => participant.agentId),
    participants: snapshot.participants,
    messages: snapshot.messages,
    round: snapshot.round,
  };
}

function attachBridge(agents: TaxChatAgentDescriptor[]): void {
  detachRuntime();
  if (!runtime.bridge) return;
  unsubscribeOutput = runtime.bridge.subscribePtyOutput((terminalId, data) => {
    const agent = agents.find((candidate) => candidate.terminalId === terminalId);
    if (agent) coordinator?.handleOutput(agent.id, data);
  });
  unsubscribeLifecycle = runtime.bridge.subscribePtyLifecycle((event) => {
    const agent = agents.find((candidate) => candidate.terminalId === event.terminalId);
    if (agent && event.type !== "status") coordinator?.handleAgentExit(agent.id);
  });
}

function statusFromTaxChatEvent(kind: string, payload: Extract<AgentEventPayload, { type: "taxchat" }>): TaxChatMessageStatus {
  if (payload.deliveredIds.length > 0) return "delivered";
  if (kind === "taxchat_message_failed" && (payload.queuedIds ?? []).length === 0) return "failed";
  if (kind === "taxchat_message_queued") return "submitted";
  return "pending";
}

function isTaxChatRoom(value: unknown): value is TaxChatRoom {
  if (!value || typeof value !== "object") return false;
  const room = value as Record<string, unknown>;
  return typeof room.id === "string"
    && typeof room.status === "string"
    && Array.isArray(room.participantIds)
    && Array.isArray(room.participants)
    && Array.isArray(room.messages)
    && typeof room.round === "number";
}

export const useTaxChatStore = create<TaxChatState>((set, get) => ({
  room: null,
  settings: DEFAULT_TAX_CHAT_SETTINGS,
  selectedAgentIds: [],

  start: (agents) => {
    coordinator?.dispose();
    detachRuntime();
    coordinator = null;
    roomId = newId();

    const selectedIds = get().selectedAgentIds;
    const selected = agents.filter((agent) => selectedIds.length === 0 || selectedIds.includes(agent.id));
    const available = selected.filter((agent) => agent.id && agent.terminalId);
    const projectId = runtime.projectId;
    set({
      room: {
        id: roomId,
        status: "ready",
        participantIds: available.map((agent) => agent.id),
        participants: available.map((agent) => ({ agentId: agent.id, status: "available", routedCount: 0 })),
        messages: [],
        round: 1,
      },
    });

    if (!available.length || !projectId) {
      set((state) => ({
        room: {
          ...state.room!,
          messages: [
            {
              id: newId(),
              senderId: "system",
              recipientIds: [],
              kind: "error",
              body: projectId
                ? "Launch at least one available agent before starting TaxChat."
                : "Open a project before starting TaxChat.",
              createdAt: new Date().toISOString(),
              status: "failed",
              round: 1,
            },
          ],
        },
      }));
      return;
    }

    coordinator = createTaxChatCoordinator({
      projectId,
      agents: available,
      settings: get().settings,
      transport: runtime.transport,
      onEvent: () => {
        if (coordinator) set({ room: snapshotRoom(coordinator) });
      },
    });

    attachBridge(available);
    coordinator.start();
    set({ room: snapshotRoom(coordinator) });
  },

  pause: (reason) => {
    coordinator?.pause(reason);
    if (coordinator) set({ room: snapshotRoom(coordinator) });
  },

  continueRoom: () => {
    coordinator?.continue();
    if (coordinator) set({ room: snapshotRoom(coordinator) });
  },

  stop: () => {
    coordinator?.stop();
    if (coordinator) set({ room: snapshotRoom(coordinator) });
  },

  send: async (body, recipientIds) => {
    if (!coordinator) return;
    await coordinator.sendUserMessage(body, recipientIds);
    set({ room: snapshotRoom(coordinator) });
  },

  setSelectedAgentIds: (ids) => {
    set({ selectedAgentIds: [...new Set(ids)] });
  },

  applyEvent: (event) => {
    if (event.source !== "taxchat") return;
    const payload = event.payload as AgentEventPayload;
    if (payload.type !== "taxchat") return;
    const current = get().room;
    const status = statusFromTaxChatEvent(event.kind, payload);
    const message = {
      id: payload.messageId,
      senderId: event.agentId ?? "user",
      recipientIds: [...payload.recipientIds],
      kind: event.agentId ? "agent" as const : "user" as const,
      body: payload.body,
      createdAt: event.timestamp,
      status,
      round: current?.round ?? 1,
    };
    if (coordinator) {
      coordinator.recordExternalMessage(message);
      set({ room: snapshotRoom(coordinator) });
      return;
    }
    const participantIds = [...new Set([...(current?.participantIds ?? []), ...payload.recipientIds])];
    set({
      room: {
        id: current?.id ?? `api-${event.projectId}`,
        status: current?.status ?? "idle",
        participantIds,
        participants: participantIds.map((agentId) => current?.participants.find((item) => item.agentId === agentId) ?? {
          agentId,
          status: payload.failedIds.includes(agentId) ? "unavailable" : "available",
          routedCount: 0,
        }),
        messages: current?.messages.some((item) => item.id === message.id)
          ? current.messages.map((item) => {
            if (item.id !== message.id) return item;
            const nextStatus = item.status === "delivered" && message.status !== "failed"
              ? "delivered"
              : message.status;
            return { ...item, status: nextStatus };
          })
          : [...(current?.messages ?? []), message],
        round: current?.round ?? 1,
      },
    });
  },

  restore: (room, agents) => {
    if (!isTaxChatRoom(room)) return;
    const projectId = runtime.projectId;
    const available = agents.filter((agent) => agent.id && agent.terminalId);
    coordinator?.dispose();
    detachRuntime();
    coordinator = null;
    roomId = room.id;

    if (!projectId || !available.length) {
      set({
        room: {
          ...room,
          participants: room.participants.map((participant) => ({ ...participant })),
          messages: room.messages.map((message) => ({ ...message, recipientIds: [...message.recipientIds] })),
          participantIds: [...room.participantIds],
        },
        selectedAgentIds: [...room.participantIds],
      });
      return;
    }

    coordinator = createTaxChatCoordinator({
      projectId,
      agents: available,
      settings: get().settings,
      transport: runtime.transport,
      onEvent: () => {
        if (coordinator) set({ room: snapshotRoom(coordinator) });
      },
    });

    const snapshot: TaxChatCoordinatorSnapshot = {
      status: room.status,
      round: room.round,
      participants: room.participants.map((participant) => ({ ...participant })),
      messages: room.messages.map((message) => ({ ...message, recipientIds: [...message.recipientIds] })),
    };
    coordinator.hydrate(snapshot);
    attachBridge(available);
    set({
      room: snapshotRoom(coordinator),
      selectedAgentIds: [...room.participantIds],
    });
  },

  reset: () => {
    coordinator?.dispose();
    detachRuntime();
    coordinator = null;
    roomId = null;
    set({ room: null, selectedAgentIds: [] });
  },
}));
