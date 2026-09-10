import { create } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { decodeSessionCheckpoint, type SessionCheckpoint } from "../lib/sessionPersistence.ts";
import type { Agent, PaneNode } from "../types/models.ts";

type ResumeAvailability = "available" | "unsupported" | "unknown";

interface SessionDescriptor {
  sessionId: string;
  projectId: string;
  agentId: string;
  name: string;
  providerId: string;
  terminalId: string;
  workingDirectory: string;
  branch: string;
  worktreePath: string | null;
  resume: { availability: ResumeAvailability } | null;
  attached: boolean;
}

interface SessionClient {
  reconnect: (protocolVersion: number, cursor: number) => Promise<{
    protocolVersion: number;
    currentSequence: number;
    events: unknown[];
    sessions: SessionDescriptor[];
  }>;
  restoreProject: (projectId: string) => Promise<{
    snapshot: SessionCheckpoint | null;
    sessionIds: string[];
    createdSessionIds: string[];
  }>;
  resume: (sessionId: string) => Promise<SessionDescriptor>;
  snapshot?: (request: {
    projectId: string;
    paneTree: unknown;
    browser: unknown[];
    taxChatRoom: unknown | null;
    lastEventSequence: number;
  }) => Promise<SessionCheckpoint>;
}

const SESSION_PROTOCOL_VERSION = 1;

const defaultClient: SessionClient = {
  reconnect: async (protocolVersion, cursor) => (await import("../tauri/sessions.ts")).sessionClient.reconnect(protocolVersion, cursor),
  restoreProject: async (projectId) => (await import("../tauri/sessions.ts")).sessionClient.restoreProject(projectId),
  resume: async (sessionId) => (await import("../tauri/sessions.ts")).sessionClient.resume(sessionId),
  snapshot: async (request) => (await import("../tauri/sessions.ts")).sessionClient.snapshot!(request),
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return error instanceof Error ? error.message : "Session operation failed";
}

export type RestoreAction = "reconnect" | "resume" | "new_session" | "unavailable";

export interface RestoredAgent {
  id: string;
  sessionId: string;
  projectId: string;
  name: string;
  providerId: string;
  terminalId: string;
  workingDirectory: string;
  branch: string;
  worktreePath: string | null;
  resumeAvailability: ResumeAvailability;
  action: RestoreAction;
  restoreMessage: string;
  scrollback: string;
  connected: boolean;
  pending: boolean;
  error: string | null;
}

interface StoredAgent {
  descriptor: SessionDescriptor;
  scrollback?: unknown;
}

interface SessionState {
  phase: "idle" | "restoring" | "ready" | "error";
  projectId: string | null;
  agents: Record<string, RestoredAgent>;
  error: string | null;
  initialize: (projectId: string) => Promise<void>;
  checkpoint: (projectId: string) => Promise<void>;
  restoreSession: (checkpoint: unknown) => Promise<void>;
  resumeAgent: (agentId: string) => Promise<void>;
}

export type SessionStore = StoreApi<SessionState> & {
  restoreSession: SessionState["restoreSession"];
  resumeAgent: SessionState["resumeAgent"];
};

function actionFor(descriptor: SessionDescriptor): Pick<RestoredAgent, "action" | "restoreMessage" | "resumeAvailability"> {
  if (descriptor.attached) {
    return { action: "reconnect", restoreMessage: "Reconnect to running session", resumeAvailability: descriptor.resume?.availability ?? "unknown" };
  }
  const availability = descriptor.resume?.availability ?? "unknown";
  if (availability === "available") return { action: "resume", restoreMessage: "Resume available", resumeAvailability: availability };
  if (availability === "unsupported") {
    return { action: "unavailable", restoreMessage: "Resume unavailable for this provider", resumeAvailability: availability };
  }
  return { action: "new_session", restoreMessage: "Start a new session", resumeAvailability: availability };
}

function restoredAgent(stored: StoredAgent): RestoredAgent {
  const descriptor = stored.descriptor;
  return {
    id: descriptor.agentId,
    sessionId: descriptor.sessionId,
    projectId: descriptor.projectId,
    name: descriptor.name || descriptor.providerId,
    providerId: descriptor.providerId,
    terminalId: descriptor.terminalId,
    workingDirectory: descriptor.workingDirectory,
    branch: descriptor.branch,
    worktreePath: descriptor.worktreePath,
    scrollback: typeof stored.scrollback === "string" ? stored.scrollback : "",
    connected: false,
    pending: false,
    error: null,
    ...actionFor(descriptor),
  };
}

function isDescriptor(value: unknown): value is SessionDescriptor {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.sessionId === "string" && typeof item.projectId === "string"
    && typeof item.agentId === "string" && typeof item.providerId === "string"
    && typeof item.terminalId === "string" && typeof item.attached === "boolean";
}

function isPaneNode(value: unknown): value is PaneNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.type === "leaf") return typeof node.id === "string" && typeof node.terminalId === "string";
  return node.type === "split" && typeof node.id === "string"
    && (node.direction === "horizontal" || node.direction === "vertical")
    && Array.isArray(node.sizes) && node.sizes.length === 2
    && node.sizes.every((size) => typeof size === "number" && Number.isFinite(size))
    && isPaneNode(node.first) && isPaneNode(node.second);
}

async function synchronizeFrontend(records: RestoredAgent[], paneTree: PaneNode | null): Promise<void> {
  if (typeof document === "undefined") return;
  const [{ useAgentStore }, { useLayoutStore }, { useTerminalStore }, { terminalRegistry }, { useWorkspaceStore }] = await Promise.all([
    import("./agentStore.ts"),
    import("./layoutStore.ts"),
    import("./terminalStore.ts"),
    import("../terminal/registry.ts"),
    import("./workspaceStore.ts"),
  ]);
  const agents: Record<string, Agent> = {};
  for (const record of records) {
    const live = record.action === "reconnect";
    agents[record.id] = {
      id: record.id,
      name: record.name,
      provider: record.providerId,
      terminalId: record.terminalId,
      cwd: record.workingDirectory,
      branch: record.branch,
      worktreePath: record.worktreePath,
      status: live ? "running" : "exited",
      projectRoot: record.projectId,
      resumeId: record.sessionId,
      createWorktree: Boolean(record.worktreePath),
    };
    useTerminalStore.getState().registerSession({
      id: record.terminalId,
      cwd: record.workingDirectory,
      status: live ? "running" : "exited",
      title: record.name,
      provider: record.providerId,
    });
    if (record.scrollback) terminalRegistry.write(record.terminalId, record.scrollback);
    useWorkspaceStore.getState().saveAgent(record.projectId, {
      resumeId: record.sessionId,
      name: record.name,
      provider: record.providerId,
      createWorktree: Boolean(record.worktreePath),
    });
  }
  useAgentStore.setState((state) => ({ agents: { ...state.agents, ...agents } }));
  if (paneTree) useLayoutStore.getState().restoreTree(paneTree);
  else {
    for (const record of records) useLayoutStore.getState().addLeaf(record.terminalId);
  }
}

function makeState(client: SessionClient) {
  return (set: StoreApi<SessionState>["setState"], get: StoreApi<SessionState>["getState"]): SessionState => ({
    phase: "idle",
    projectId: null,
    agents: {},
    error: null,

    initialize: async (projectId) => {
      set({ phase: "restoring", projectId, agents: {}, error: null });
      try {
        const restored = await client.restoreProject(projectId);
        if (restored.snapshot) await get().restoreSession(restored.snapshot);
        const connected = await client.reconnect(SESSION_PROTOCOL_VERSION, restored.snapshot?.lastEventSequence ?? 0);
        const bySession = new Map(connected.sessions.map((descriptor) => [descriptor.sessionId, descriptor]));
        set((state) => {
          const agents = { ...state.agents };
          for (const [id, record] of Object.entries(agents)) {
            const descriptor = bySession.get(record.sessionId);
            if (descriptor) agents[id] = { ...record, terminalId: descriptor.terminalId, ...actionFor(descriptor) };
          }
          return { agents, phase: "ready", error: null };
        });
      } catch (error) {
        set({ phase: "error", error: errorMessage(error) });
      }
    },

    checkpoint: async (projectId) => {
      if (!client.snapshot || typeof document === "undefined") return;
      const [{ useLayoutStore }, { useUiStore }, { useTaxChatStore }, { useAttentionStore }] = await Promise.all([
        import("./layoutStore.ts"), import("./uiStore.ts"), import("./taxChatStore.ts"), import("./attentionStore.ts"),
      ]);
      const ui = useUiStore.getState();
      try {
        await client.snapshot({
          projectId,
          paneTree: useLayoutStore.getState().paneTree,
          browser: ui.browserUrl ? [{ url: ui.browserUrl, open: ui.browserOpen }] : [],
          taxChatRoom: useTaxChatStore.getState().room,
          lastEventSequence: useAttentionStore.getState().lastSequence,
        });
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    restoreSession: async (input) => {
      const decoded = decodeSessionCheckpoint(input);
      if (!decoded.ok) {
        set({ phase: "error", error: decoded.error.message });
        return;
      }
      const records = decoded.value.agents
        .filter((value): value is StoredAgent => Boolean(value && typeof value === "object" && isDescriptor((value as StoredAgent).descriptor)))
        .map(restoredAgent);
      const agents = Object.fromEntries(records.map((record) => [record.id, record]));
      const paneTree = isPaneNode(decoded.value.paneTree) ? decoded.value.paneTree : null;
      set({ phase: "ready", projectId: decoded.value.projectId, agents, error: null });
      await synchronizeFrontend(records, paneTree);
    },

    resumeAgent: async (agentId) => {
      const current = get().agents[agentId];
      if (!current || current.pending || current.action === "unavailable" || current.action === "new_session") return;
      set((state) => ({ agents: { ...state.agents, [agentId]: { ...current, pending: true, error: null } } }));
      try {
        const descriptor = await client.resume(current.sessionId);
        const next: RestoredAgent = { ...current, terminalId: descriptor.terminalId, connected: true, pending: false, error: null, ...actionFor(descriptor) };
        set((state) => ({ agents: { ...state.agents, [agentId]: next } }));
        if (typeof document !== "undefined") {
          const [{ useTerminalStore }, { useAgentStore }, { useLayoutStore }] = await Promise.all([
            import("./terminalStore.ts"), import("./agentStore.ts"), import("./layoutStore.ts"),
          ]);
          useTerminalStore.getState().registerSession({
          id: next.terminalId,
          cwd: next.workingDirectory,
          status: "running",
          title: next.name,
          provider: next.providerId,
          });
          useAgentStore.setState((state) => ({
          agents: {
            ...state.agents,
            [agentId]: { ...state.agents[agentId], terminalId: next.terminalId, status: "running", error: null },
          },
          }));
          if (current.terminalId !== next.terminalId) useLayoutStore.getState().replaceTerminal(current.terminalId, next.terminalId);
        }
      } catch (error) {
        set((state) => ({ agents: { ...state.agents, [agentId]: { ...current, pending: false, error: errorMessage(error) } } }));
      }
    },
  });
}

export function createSessionStoreForTest(client: SessionClient): SessionStore {
  const store = createStore<SessionState>(makeState(client));
  return Object.assign(store, {
    restoreSession: (checkpoint: unknown) => store.getState().restoreSession(checkpoint),
    resumeAgent: (agentId: string) => store.getState().resumeAgent(agentId),
  });
}

export const useSessionStore = create<SessionState>(makeState(defaultClient));
