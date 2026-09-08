import { create } from "zustand";
import { createTaxChatCoordinator, type TaxChatAgentDescriptor, type TaxChatCoordinator, type TaxChatTransport } from "../lib/taxChatCoordinator.ts";
import { newId } from "../lib/ids.ts";
import type { TaxChatRoom, TaxChatRoomSettings } from "../types";
import type { PtyLifecycleEvent } from "../lib/ptyEventFanout.ts";

export interface TaxChatPtyBridge {
  subscribePtyOutput: (listener: (terminalId: string, data: string) => void) => () => void;
  subscribePtyLifecycle: (listener: (event: PtyLifecycleEvent) => void) => () => void;
}

export interface TaxChatRuntime {
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
  reset: () => void;
}

export const DEFAULT_TAX_CHAT_SETTINGS: TaxChatRoomSettings = {
  inactivityMs: 45_000,
  perAgentMessageLimit: 8,
  totalMessageLimit: 64,
};

let runtime: TaxChatRuntime = {
  transport: {
    write: async () => {
      throw new Error("TaxChat PTY transport is not configured.");
    },
  },
  bridge: null,
};
let coordinator: TaxChatCoordinator | null = null;
let roomId: string | null = null;
let unsubscribeOutput: (() => void) | null = null;
let unsubscribeLifecycle: (() => void) | null = null;

export function configureTaxChatRuntime(next: TaxChatRuntime): void {
  runtime = next;
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

    if (!available.length) {
      set((state) => ({
        room: {
          ...state.room!,
          participants: available.map((agent) => ({ agentId: agent.id, status: "available", routedCount: 0 })),
          messages: [
            {
              id: newId(),
              senderId: "system",
              recipientIds: [],
              kind: "error",
              body: "Launch at least one available agent before starting TaxChat.",
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
      agents: available,
      settings: get().settings,
      transport: runtime.transport,
      onEvent: () => {
        if (coordinator) set({ room: snapshotRoom(coordinator) });
      },
    });

    if (runtime.bridge) {
      unsubscribeOutput = runtime.bridge.subscribePtyOutput((terminalId, data) => {
        const agent = available.find((candidate) => candidate.terminalId === terminalId);
        if (agent) coordinator?.handleOutput(agent.id, data);
      });
      unsubscribeLifecycle = runtime.bridge.subscribePtyLifecycle((event) => {
        const agent = available.find((candidate) => candidate.terminalId === event.terminalId);
        if (agent && event.type !== "status") coordinator?.handleAgentExit(agent.id);
      });
    }

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

  reset: () => {
    coordinator?.dispose();
    detachRuntime();
    coordinator = null;
    roomId = null;
    set({ room: null, selectedAgentIds: [] });
  },
}));
