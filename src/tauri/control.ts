import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEventEnvelope } from "../lib/agentEvents.ts";
import { invokeCmd } from "./invoke.ts";

export interface ControlClient {
  subscribe: (handler: (event: unknown) => void) => Promise<UnlistenFn>;
  replay: (sequence: number) => Promise<unknown[]>;
  acknowledgeAgent: (projectId: string, agentId: string) => Promise<unknown>;
  markAllRead: (projectId: string) => Promise<unknown>;
}

export function subscribeControlEvents(handler: (event: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>("control-event", ({ payload }) => handler(payload));
}

export function controlEventsAfter(sequence: number): Promise<AgentEventEnvelope[]> {
  return invokeCmd<AgentEventEnvelope[]>("control_events_after", { sequence });
}

export function attentionAck(projectId: string, agentId: string): Promise<AgentEventEnvelope> {
  return invokeCmd<AgentEventEnvelope>("attention_ack", { projectId, agentId });
}

export function attentionMarkAllRead(projectId: string): Promise<AgentEventEnvelope> {
  return invokeCmd<AgentEventEnvelope>("attention_mark_all_read", { projectId });
}

export const controlClient: ControlClient = {
  subscribe: subscribeControlEvents,
  replay: controlEventsAfter,
  acknowledgeAgent: attentionAck,
  markAllRead: attentionMarkAllRead,
};
