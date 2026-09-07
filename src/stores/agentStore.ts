import { create } from "zustand";
import { isCommandMissing, toAppError } from "../lib/errors";
import { newId } from "../lib/ids";
import { sessionFromAgent } from "../lib/terminalSessions";
import { launchAgent, listAgentProviders, stopAgent } from "../tauri/agents";
import { gitCreateWorktree } from "../tauri/git";
import type { Agent, AgentProvider, AgentProviderId, AppError, LaunchAgentRequest } from "../types";
import { PROVIDER_CATALOG, worktreeProviderSlug } from "../types";
import { useLayoutStore } from "./layoutStore";
import { useProjectStore } from "./projectStore";
import { useTerminalStore } from "./terminalStore";

interface AgentState {
  agents: Record<string, Agent>;
  providers: AgentProvider[];
  providersLoaded: boolean;
  providersError: AppError | null;
  selectedAgentId: string | null;
  launchError: AppError | null;
  launching: boolean;
  loadProviders: () => Promise<void>;
  selectAgent: (id: string | null) => void;
  launch: (input: {
    name: string;
    provider: AgentProviderId;
    createWorktree: boolean;
  }) => Promise<Agent | null>;
  stop: (id: string) => Promise<void>;
  remove: (id: string) => void;
}

function unavailableProviders(): AgentProvider[] {
  return PROVIDER_CATALOG.map((item) => ({
    id: item.id,
    displayName: item.displayName,
    executable: "",
    installed: false,
  }));
}

function mergeProviders(detected: AgentProvider[]): AgentProvider[] {
  const normalizeId = (id: string): string => {
    if (id === "claude") return "claude-code";
    if (id === "cursor") return "cursor-agent";
    return id;
  };
  const normalized = detected.map((provider) => ({
    ...provider,
    id: normalizeId(String(provider.id)),
  }));
  const known = PROVIDER_CATALOG.map((item) => {
    const match = detected.find((provider) => {
      return normalizeId(String(provider.id)) === item.id;
    });
    if (!match) {
      return {
        id: item.id,
        displayName: item.displayName,
        executable: "",
        installed: false,
      };
    }
    return {
      ...match,
      id: normalizeId(String(match.id)),
      displayName: match.displayName || item.displayName,
      installed: Boolean(match.installed),
    };
  });
  const knownIds = new Set(PROVIDER_CATALOG.map((item) => item.id));
  const extras = normalized.filter((provider) => !knownIds.has(provider.id));
  return [...known, ...extras];
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: {},
  providers: unavailableProviders(),
  providersLoaded: false,
  providersError: null,
  selectedAgentId: null,
  launchError: null,
  launching: false,

  loadProviders: async () => {
    set({ providersError: null });
    try {
      const detected = await listAgentProviders();
      set({
        providers: mergeProviders(detected),
        providersLoaded: true,
        providersError: null,
      });
    } catch (err) {
      const parsed = toAppError(err);
      set({
        providers: unavailableProviders(),
        providersLoaded: true,
        providersError: isCommandMissing(parsed)
          ? {
              code: parsed.code,
              message: "Agent provider detection is not available yet (list_agent_providers).",
            }
          : parsed,
      });
    }
  },

  selectAgent: (id) => {
    set({ selectedAgentId: id });
    if (!id) return;
    const agent = get().agents[id];
    if (agent) useLayoutStore.getState().focusTerminal(agent.terminalId);
  },

  launch: async ({ name, provider, createWorktree }) => {
    const project = useProjectStore.getState().project;
    if (!project) {
      const error = { code: "no_project", message: "Open a project before launching an agent." };
      set({ launchError: error });
      return null;
    }

    const catalog = get().providers.find((item) => item.id === provider);
    if (provider !== "shell" && catalog && !catalog.installed) {
      const error = {
        code: "provider_unavailable",
        message: `${catalog.displayName} is not installed.`,
      };
      set({ launchError: error });
      return null;
    }

    set({ launching: true, launchError: null });
    const request: LaunchAgentRequest = {
      name: name.trim() || provider,
      provider,
      cwd: project.path,
      createWorktree,
      cols: 80,
      rows: 24,
    };

    try {
      try {
        const agent = await launchAgent(request);
        useTerminalStore.getState().registerSession(sessionFromAgent(agent, 80, 24));
        set((state) => ({
          agents: { ...state.agents, [agent.id]: agent },
          selectedAgentId: agent.id,
          launching: false,
        }));
        useLayoutStore.getState().addLeaf(agent.terminalId);
        return agent;
      } catch (err) {
        const parsed = toAppError(err);
        if (!isCommandMissing(parsed)) throw parsed;
      }

      let cwd = project.path;
      let branch = project.currentBranch;
      let worktreePath: string | null = null;

      if (createWorktree) {
        const created = await gitCreateWorktree({
          repositoryRoot: project.repositoryRoot,
          provider: worktreeProviderSlug(provider),
          baseBranch: project.baseBranch,
        });
        cwd = created.worktreePath;
        branch = created.branch;
        worktreePath = created.worktreePath;
      }

      const session = await useTerminalStore.getState().createSession({
        cwd,
        cols: 80,
        rows: 24,
        title: request.name,
      });

      const agent: Agent = {
        id: newId(),
        name: request.name,
        provider,
        terminalId: session.id,
        cwd,
        branch,
        worktreePath,
        status:
          session.status === "running" || session.status === "starting"
            ? session.status
            : session.status === "exited" || session.status === "killed"
              ? "exited"
              : "error",
        error: session.error,
      };
      set((state) => ({
        agents: { ...state.agents, [agent.id]: agent },
        selectedAgentId: agent.id,
        launching: false,
        launchError: agent.error
          ? { code: "agent_launch_error", message: agent.error }
          : null,
      }));
      useLayoutStore.getState().addLeaf(agent.terminalId);
      return agent;
    } catch (err) {
      const parsed = toAppError(err);
      set({ launching: false, launchError: parsed });
      return null;
    }
  },

  stop: async (id) => {
    const agent = get().agents[id];
    if (!agent) return;
    try {
      await stopAgent(id);
    } catch (err) {
      const parsed = toAppError(err);
      if (!isCommandMissing(parsed)) {
        set((state) => ({
          agents: {
            ...state.agents,
            [id]: { ...agent, status: "error", error: parsed.message },
          },
        }));
        return;
      }
    }
    set((state) => ({
      agents: {
        ...state.agents,
        [id]: { ...agent, status: "exited" },
      },
    }));
  },

  remove: (id) =>
    set((state) => {
      const next = { ...state.agents };
      delete next[id];
      return {
        agents: next,
        selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
      };
    }),
}));
