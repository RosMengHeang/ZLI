import { create } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  deriveNotification,
  reduceAttention,
  type AttentionNotification,
  type AttentionState,
} from "../lib/attention.ts";
import { isAgentEventEnvelope, type AgentEventEnvelope } from "../lib/agentEvents.ts";
import { toAppError } from "../lib/errors.ts";
import { controlClient, type ControlClient } from "../tauri/control.ts";
import type { AppError } from "../types";

export interface AttentionRecord extends AttentionState {
  agentId: string;
  projectId: string;
  lastEventAt: string;
  lastSequence: number;
  lastOutputAt?: number;
}

export interface SequencedAttentionNotification extends AttentionNotification {
  sequence: number;
}

interface AttentionDependencies {
  client: ControlClient;
  now: () => number;
}

export interface AttentionStoreState {
  records: Record<string, AttentionRecord>;
  notifications: SequencedAttentionNotification[];
  events: AgentEventEnvelope[];
  loading: boolean;
  connected: boolean;
  error: AppError | null;
  lastSequence: number;
  pendingAgentIds: string[];
  markingAllRead: boolean;
  apply: (event: unknown) => boolean;
  connect: () => Promise<() => void>;
  retryConnection: () => Promise<boolean>;
  acknowledgeAgent: (agentId: string, projectId?: string) => Promise<boolean>;
  markAllRead: (projectId: string) => Promise<boolean>;
  get: (agentId: string, projectId?: string) => AttentionRecord | undefined;
  projectUnreadCount: (projectId: string) => number;
  nextUnreadAgent: (projectId?: string) => string | null;
  clearError: () => void;
}

const defaultAttentionState = (): AttentionState => ({
  executionStatus: "starting",
  attentionStatus: "working",
  unread: false,
  unreadCount: 0,
});

function recordKey(projectId: string, agentId: string): string {
  return `${projectId}\u0000${agentId}`;
}

function eventOrder(left: AgentEventEnvelope, right: AgentEventEnvelope): number {
  return left.sequence - right.sequence || left.eventId.localeCompare(right.eventId);
}

function projectEvents(
  events: AgentEventEnvelope[],
  lastOutputByAgent: Map<string, number>,
): Pick<AttentionStoreState, "records" | "notifications" | "lastSequence"> {
  const records: Record<string, AttentionRecord> = {};
  let notifications: SequencedAttentionNotification[] = [];
  let lastSequence = 0;

  for (const event of [...events].sort(eventOrder)) {
    lastSequence = Math.max(lastSequence, event.sequence);
    if (event.kind === "attention_mark_all_read") {
      notifications = notifications.filter((item) => item.projectId !== event.projectId);
      for (const [key, record] of Object.entries(records)) {
        if (record.projectId !== event.projectId) continue;
        records[key] = {
          ...record,
          ...reduceAttention(record, event),
          lastEventAt: event.timestamp,
          lastSequence: event.sequence,
        };
      }
      continue;
    }
    if (!event.agentId) continue;

    const key = recordKey(event.projectId, event.agentId);
    if (event.kind === "attention_ack") {
      notifications = notifications.filter((item) =>
        item.projectId !== event.projectId || item.agentId !== event.agentId);
    }
    const previous = records[key] ?? {
      ...defaultAttentionState(),
      agentId: event.agentId,
      projectId: event.projectId,
      lastEventAt: event.timestamp,
      lastSequence: event.sequence,
    };
    const notification = deriveNotification(event, previous);
    if (notification) notifications.push({ ...notification, sequence: event.sequence });
    records[key] = {
      ...previous,
      ...reduceAttention(previous, event),
      lastEventAt: event.timestamp,
      lastSequence: event.sequence,
      lastOutputAt: lastOutputByAgent.get(key),
    };
  }

  return { records, notifications, lastSequence };
}

function createAttentionState(dependencies: AttentionDependencies) {
  const seenEventIds = new Set<string>();
  const lastOutputByAgent = new Map<string, number>();
  const latestOutputSequence = new Map<string, number>();
  let unsubscribe: (() => void) | null = null;
  let connecting: Promise<void> | null = null;
  let consumers = 0;

  return (
    set: StoreApi<AttentionStoreState>["setState"],
    get: StoreApi<AttentionStoreState>["getState"],
  ): AttentionStoreState => {
    const disconnect = () => {
      unsubscribe?.();
      unsubscribe = null;
      connecting = null;
      set({ connected: false });
    };

    const startConnection = async () => {
      if (unsubscribe) return;
      if (!connecting) {
        set({ loading: true, error: null });
        const replayCursor = get().lastSequence;
        connecting = (async () => {
          try {
            unsubscribe = await dependencies.client.subscribe((event) => get().apply(event));
            const replay = await dependencies.client.replay(replayCursor);
            for (const event of replay) get().apply(event);
            set({ loading: false, connected: true });
          } catch (error) {
            unsubscribe?.();
            unsubscribe = null;
            set({ loading: false, connected: false, error: toAppError(error) });
          } finally {
            connecting = null;
          }
        })();
      }
      await connecting;
    };

    return {
      records: {},
      notifications: [],
      events: [],
      loading: false,
      connected: false,
      error: null,
      lastSequence: 0,
      pendingAgentIds: [],
      markingAllRead: false,

      apply: (candidate) => {
        if (!isAgentEventEnvelope(candidate) || seenEventIds.has(candidate.eventId)) return false;
        seenEventIds.add(candidate.eventId);

        const key = candidate.agentId ? recordKey(candidate.projectId, candidate.agentId) : null;
        if (key && candidate.kind === "agent_output") {
          const priorSequence = latestOutputSequence.get(key) ?? -1;
          if (candidate.sequence >= priorSequence) {
            const currentNow = dependencies.now();
            if (Number.isFinite(currentNow) && currentNow >= 0) {
              lastOutputByAgent.set(key, Math.max(lastOutputByAgent.get(key) ?? 0, currentNow));
              latestOutputSequence.set(key, candidate.sequence);
            }
          }
        }

        const events = [...get().events, candidate];
        set({ events, ...projectEvents(events, lastOutputByAgent) });
        return true;
      },

      connect: async () => {
        consumers += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          consumers = Math.max(0, consumers - 1);
          if (consumers === 0) disconnect();
        };
        await startConnection();
        return release;
      },

      retryConnection: async () => {
        await startConnection();
        return get().connected;
      },

      acknowledgeAgent: async (agentId, requestedProjectId) => {
        const record = Object.values(get().records).find((item) =>
          item.agentId === agentId && (!requestedProjectId || item.projectId === requestedProjectId));
        if (!record || !record.unread) return true;
        set((state) => ({
          error: null,
          pendingAgentIds: [...new Set([...state.pendingAgentIds, agentId])],
        }));
        try {
          const event = await dependencies.client.acknowledgeAgent(record.projectId, agentId);
          if (!isAgentEventEnvelope(event)
            || event.kind !== "attention_ack"
            || event.projectId !== record.projectId
            || event.agentId !== agentId) {
            throw new Error("The acknowledgement response was invalid.");
          }
          get().apply(event);
          return true;
        } catch (error) {
          set({ error: toAppError(error) });
          return false;
        } finally {
          set((state) => ({ pendingAgentIds: state.pendingAgentIds.filter((id) => id !== agentId) }));
        }
      },

      markAllRead: async (projectId) => {
        if (!projectId || get().projectUnreadCount(projectId) === 0) return true;
        set({ markingAllRead: true, error: null });
        try {
          const event = await dependencies.client.markAllRead(projectId);
          if (!isAgentEventEnvelope(event)
            || event.kind !== "attention_mark_all_read"
            || event.projectId !== projectId
            || event.agentId !== null) {
            throw new Error("The mark-all-read response was invalid.");
          }
          get().apply(event);
          return true;
        } catch (error) {
          set({ error: toAppError(error) });
          return false;
        } finally {
          set({ markingAllRead: false });
        }
      },

      get: (agentId, projectId) => Object.values(get().records).find((record) =>
        record.agentId === agentId && (!projectId || record.projectId === projectId)),
      projectUnreadCount: (projectId) => Object.values(get().records)
        .filter((record) => record.projectId === projectId)
        .reduce((count, record) => count + record.unreadCount, 0),
      nextUnreadAgent: (projectId) => {
        const notification = [...get().notifications]
          .sort((left, right) => right.sequence - left.sequence)
          .find((item) => {
            if (!item.agentId || (projectId && item.projectId !== projectId)) return false;
            return get().records[recordKey(item.projectId, item.agentId)]?.unread;
          });
        return notification?.agentId ?? null;
      },
      clearError: () => set({ error: null }),
    };
  };
}

const defaultDependencies: AttentionDependencies = {
  client: controlClient,
  now: () => performance.now(),
};

export function createAttentionStoreForTest(
  dependencies: Partial<AttentionDependencies> & Pick<AttentionDependencies, "client">,
) {
  return createStore<AttentionStoreState>()(createAttentionState({ ...defaultDependencies, ...dependencies }));
}

export const useAttentionStore = create<AttentionStoreState>()(createAttentionState(defaultDependencies));

export function acknowledgeAgent(agentId: string, projectId?: string): Promise<boolean> {
  return useAttentionStore.getState().acknowledgeAgent(agentId, projectId);
}

export function markAllRead(projectId: string): Promise<boolean> {
  return useAttentionStore.getState().markAllRead(projectId);
}

export function nextUnreadAgent(projectId?: string): string | null {
  return useAttentionStore.getState().nextUnreadAgent(projectId);
}
