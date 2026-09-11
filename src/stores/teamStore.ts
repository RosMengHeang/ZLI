import { create } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { isAgentEventEnvelope, type AgentEventEnvelope, type AgentEventPayload } from "../lib/agentEvents.ts";
import { controlClient, type ControlClient } from "../control/client.ts";

export type TeamAgentStatus = "pending" | "running" | "paused" | "stopped" | "failed";

export interface TeamAgentRecord {
  agentId: string;
  parentAgentId: string | null;
  projectId: string;
  providerId?: string;
  name?: string;
  terminalId?: string;
  branch?: string;
  worktreePath?: string;
  status: TeamAgentStatus;
  lastSequence: number;
  pendingAction: "pause" | "stop" | null;
  error: string | null;
}

interface TeamDependencies {
  client: ControlClient;
  createId: () => string;
}

export interface SpawnAgentInput {
  projectId: string;
  parentAgentId: string | null;
  providerId: string;
  task: string;
  name?: string;
}

export interface TeamSpawnActivity extends SpawnAgentInput {
  id: string;
  status: "pending" | "succeeded" | "failed";
  agentId: string | null;
  error: string | null;
}

export interface SendMessageInput {
  projectId: string;
  agentId: string;
  body: string;
}

export interface TeamMessageDelivery extends SendMessageInput {
  id: string;
  messageId: string | null;
  status: "pending" | "queued" | "delivered" | "failed";
  error: string | null;
}

interface SpawnResult {
  agentId: string;
  parentAgentId: string | null;
  projectId: string;
  providerId: string;
  name: string;
  terminalId: string;
  branch: string;
  worktreePath: string;
  paused: boolean;
}

interface SendResult {
  messageId: string;
  queued: boolean;
}

export interface TeamStoreState {
  agents: Record<string, TeamAgentRecord>;
  spawns: Record<string, TeamSpawnActivity>;
  deliveries: Record<string, TeamMessageDelivery>;
  lastSequence: number;
  hydrateAgent: (agent: Omit<TeamAgentRecord, "lastSequence" | "pendingAction" | "error">) => void;
  apply: (event: unknown) => boolean;
  rootAgentIds: (projectId: string) => string[];
  childAgentIds: (parentAgentId: string) => string[];
  spawnAgent: (input: SpawnAgentInput) => Promise<TeamAgentRecord | null>;
  sendMessage: (input: SendMessageInput) => Promise<string>;
  pauseAgent: (projectId: string, agentId: string) => Promise<boolean>;
  stopAgent: (projectId: string, agentId: string) => Promise<boolean>;
}

export const MAX_TEAM_AGENTS = 12;
const DELIVERY_CONFIRMATION_TIMEOUT_MS = 30_000;

function statusForEvent(event: AgentEventEnvelope): TeamAgentStatus | null {
  switch (event.kind) {
    case "agent_created":
      return "pending";
    case "agent_started":
      return "running";
    case "agent_paused":
      return "paused";
    case "agent_stopped":
    case "agent_exited":
      return "stopped";
    case "agent_failed":
      return "failed";
    default:
      return null;
  }
}

function createTeamState(_dependencies: TeamDependencies) {
  const seenEventIds = new Set<string>();
  const deliveryWaiters = new Map<string, {
    resolve: (outcome: "delivered" | "failed" | "timeout") => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const waitForDelivery = (messageId: string, get: () => TeamStoreState): Promise<"delivered" | "failed" | "timeout"> => {
    const existing = Object.values(get().deliveries).find((delivery) => delivery.messageId === messageId);
    if (existing?.status === "delivered") return Promise.resolve("delivered");
    if (existing?.status === "failed") return Promise.resolve("failed");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        deliveryWaiters.delete(messageId);
        resolve("timeout");
      }, DELIVERY_CONFIRMATION_TIMEOUT_MS);
      const nodeTimer = timer as unknown as { unref?: () => void };
      nodeTimer.unref?.();
      deliveryWaiters.set(messageId, { resolve, timer });
    });
  };

  const resolveDeliveryWaiter = (messageId: string, outcome: "delivered" | "failed"): void => {
    const waiter = deliveryWaiters.get(messageId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    deliveryWaiters.delete(messageId);
    waiter.resolve(outcome);
  };

  const errorMessage = (error: unknown): string => error instanceof Error ? error.message : "Team operation failed";

  const activeAgentCount = (state: TeamStoreState, projectId: string): number => {
    const active = Object.values(state.agents).filter((agent) =>
      agent.projectId === projectId && agent.status !== "failed" && agent.status !== "stopped",
    ).length;
    const pending = Object.values(state.spawns).filter((spawn) =>
      spawn.projectId === projectId && spawn.status === "pending",
    ).length;
    return active + pending;
  };

  return (set: StoreApi<TeamStoreState>["setState"], get: StoreApi<TeamStoreState>["getState"]): TeamStoreState => ({
    agents: {},
    spawns: {},
    deliveries: {},
    lastSequence: 0,

    hydrateAgent: (agent) => set((state) => ({
      agents: {
        ...state.agents,
        [agent.agentId]: {
          ...agent,
          lastSequence: state.agents[agent.agentId]?.lastSequence ?? 0,
          pendingAction: null,
          error: null,
        },
      },
    })),

    apply: (candidate) => {
      if (!isAgentEventEnvelope(candidate) || seenEventIds.has(candidate.eventId)) return false;
      const payload = candidate.payload as AgentEventPayload;
      seenEventIds.add(candidate.eventId);
      const status = statusForEvent(candidate);
      const agentId = candidate.agentId;

      set((state) => {
        const next = { lastSequence: Math.max(state.lastSequence, candidate.sequence) } as Partial<TeamStoreState>;
        if (candidate.kind === "agent_message_queued"
          || candidate.kind === "agent_message_delivered"
          || candidate.kind === "agent_message_failed") {
          const message = payload as { type: "message"; messageId: string };
          const existing = Object.values(state.deliveries).find((delivery) => delivery.messageId === message.messageId);
          const id = existing?.id ?? message.messageId;
          return {
            ...next,
            deliveries: {
              ...state.deliveries,
              [id]: {
                id,
                projectId: candidate.projectId,
                agentId: agentId ?? "",
                body: existing?.body ?? "",
                messageId: message.messageId,
                status: candidate.kind === "agent_message_queued"
                  ? "queued"
                  : candidate.kind === "agent_message_delivered" ? "delivered" : "failed",
                error: candidate.kind === "agent_message_failed" ? "Message delivery failed" : null,
              },
            },
          };
        }
        if (!status || !agentId) return next;
        const current = state.agents[agentId];
        if (current && current.lastSequence > candidate.sequence) return next;
        const descriptor = payload.type === "agent"
          ? {
              providerId: payload.providerId,
              name: payload.name,
              terminalId: payload.terminalId,
              branch: payload.branch,
              worktreePath: payload.worktreePath,
            }
          : {};
        return {
          ...next,
          agents: {
            ...state.agents,
            [agentId]: {
              ...(current ?? {}),
              agentId,
              parentAgentId: candidate.parentAgentId,
              projectId: candidate.projectId,
              ...descriptor,
              status,
              lastSequence: candidate.sequence,
              pendingAction: null,
              error: null,
            },
          },
        };
      });
      if (candidate.kind === "agent_message_delivered" || candidate.kind === "agent_message_failed") {
        const message = payload as { type: "message"; messageId: string };
        resolveDeliveryWaiter(message.messageId, candidate.kind === "agent_message_delivered" ? "delivered" : "failed");
      }
      return true;
    },

    rootAgentIds: (projectId) => Object.values(get().agents)
      .filter((agent) => agent.projectId === projectId && agent.parentAgentId === null)
      .sort((left, right) => left.lastSequence - right.lastSequence || left.agentId.localeCompare(right.agentId))
      .map((agent) => agent.agentId),

    childAgentIds: (parentAgentId) => Object.values(get().agents)
      .filter((agent) => agent.parentAgentId === parentAgentId)
      .sort((left, right) => left.lastSequence - right.lastSequence || left.agentId.localeCompare(right.agentId))
      .map((agent) => agent.agentId),

    spawnAgent: async (input) => {
      const id = _dependencies.createId();
      const activity: TeamSpawnActivity = {
        ...input,
        id,
        status: "pending",
        agentId: null,
        error: null,
      };
      if (activeAgentCount(get(), input.projectId) >= MAX_TEAM_AGENTS) {
        set((state) => ({
          spawns: {
            ...state.spawns,
            [id]: { ...activity, status: "failed", error: "This project already has 12 agents" },
          },
        }));
        return null;
      }
      set((state) => ({ spawns: { ...state.spawns, [id]: activity } }));
      try {
        const child = await _dependencies.client.request<SpawnResult>("agent.spawn", input, { id });
        const record: TeamAgentRecord = {
          agentId: child.agentId,
          parentAgentId: child.parentAgentId,
          projectId: child.projectId,
          providerId: child.providerId,
          name: child.name,
          terminalId: child.terminalId,
          branch: child.branch,
          worktreePath: child.worktreePath,
          status: child.paused ? "paused" : "running",
          lastSequence: 0,
          pendingAction: null,
          error: null,
        };
        set((state) => ({
          agents: { ...state.agents, [record.agentId]: record },
          spawns: {
            ...state.spawns,
            [id]: { ...state.spawns[id], status: "succeeded", agentId: record.agentId, error: null },
          },
        }));
        return record;
      } catch (error) {
        set((state) => ({
          spawns: {
            ...state.spawns,
            [id]: { ...state.spawns[id], status: "failed", agentId: null, error: errorMessage(error) },
          },
        }));
        return null;
      }
    },

    sendMessage: async (input) => {
      const id = _dependencies.createId();
      const delivery: TeamMessageDelivery = {
        ...input,
        id,
        messageId: null,
        status: "pending",
        error: null,
      };
      set((state) => ({ deliveries: { ...state.deliveries, [id]: delivery } }));
      try {
        const result = await _dependencies.client.request<SendResult>("agent.send", input, { id });
        set((state) => {
          const remoteEntry = Object.entries(state.deliveries).find(([entryId, candidate]) =>
            entryId !== id && candidate.messageId === result.messageId,
          );
          const remote = remoteEntry?.[1];
          const next = {
            ...state.deliveries,
            [id]: {
              ...state.deliveries[id],
              ...remote,
              id,
              messageId: result.messageId,
              status: remote?.status ?? (result.queued ? "queued" : "failed"),
              error: remote?.error ?? (result.queued ? null : "Message was not queued"),
            },
          };
          if (remoteEntry) delete next[remoteEntry[0]];
          return { deliveries: next };
        });
        if (result.queued) {
          const outcome = await waitForDelivery(result.messageId, get);
          if (outcome === "timeout") {
            set((state) => ({
              deliveries: {
                ...state.deliveries,
                [id]: {
                  ...state.deliveries[id],
                  status: "failed",
                  error: "Timed out waiting for delivery confirmation",
                },
              },
            }));
          }
        }
      } catch (error) {
        set((state) => ({
          deliveries: {
            ...state.deliveries,
            [id]: { ...state.deliveries[id], status: "failed", error: errorMessage(error) },
          },
        }));
      }
      return id;
    },

    pauseAgent: async (projectId, agentId) => {
      const current = get().agents[agentId];
      if (!current || current.projectId !== projectId) return false;
      set((state) => ({
        agents: { ...state.agents, [agentId]: { ...state.agents[agentId], pendingAction: "pause", error: null } },
      }));
      try {
        await _dependencies.client.request("agent.pause", { projectId, agentId });
        set((state) => ({
          agents: { ...state.agents, [agentId]: { ...state.agents[agentId], status: "paused", pendingAction: null } },
        }));
        return true;
      } catch (error) {
        set((state) => ({
          agents: { ...state.agents, [agentId]: { ...state.agents[agentId], pendingAction: null, error: errorMessage(error) } },
        }));
        return false;
      }
    },

    stopAgent: async (projectId, agentId) => {
      const current = get().agents[agentId];
      if (!current || current.projectId !== projectId) return false;
      set((state) => ({
        agents: { ...state.agents, [agentId]: { ...state.agents[agentId], pendingAction: "stop", error: null } },
      }));
      try {
        await _dependencies.client.request("agent.stop", { projectId, agentId });
        set((state) => ({
          agents: { ...state.agents, [agentId]: { ...state.agents[agentId], status: "stopped", pendingAction: null } },
        }));
        return true;
      } catch (error) {
        set((state) => ({
          agents: { ...state.agents, [agentId]: { ...state.agents[agentId], pendingAction: null, error: errorMessage(error) } },
        }));
        return false;
      }
    },
  });
}

export function createTeamStoreForTest(dependencies: Pick<TeamDependencies, "client"> & Partial<TeamDependencies>) {
  return createStore<TeamStoreState>()(createTeamState({
    createId: () => globalThis.crypto.randomUUID(),
    ...dependencies,
  }));
}

export const useTeamStore = create<TeamStoreState>()(createTeamState({
  client: controlClient,
  createId: () => globalThis.crypto.randomUUID(),
}));
