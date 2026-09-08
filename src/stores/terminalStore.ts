import { create } from "zustand";
import { isCommandMissing, toAppError } from "../lib/errors";
import { newId } from "../lib/ids";
import { ptyClose, ptyCreate, ptyResize, ptyWrite } from "../tauri/terminal";
import { terminalRegistry } from "../terminal/registry";
import type { CreatePtyRequest, TerminalSession } from "../types";

interface TerminalState {
  sessions: Record<string, TerminalSession>;
  upsert: (session: TerminalSession) => void;
  registerSession: (session: TerminalSession) => void;
  markExited: (id: string, exitCode: number | null) => void;
  markError: (id: string, message: string) => void;
  createSession: (request: CreatePtyRequest) => Promise<TerminalSession>;
  stopSession: (id: string) => Promise<void>;
  closeSession: (id: string) => Promise<boolean>;
  resizeSession: (id: string, cols: number, rows: number) => void;
}

const lastSize = new Map<string, string>();
const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearResizeState(id: string): void {
  lastSize.delete(id);
  const timer = resizeTimers.get(id);
  if (timer) clearTimeout(timer);
  resizeTimers.delete(id);
}

function bindInput(id: string): void {
  let pending = "";
  let flushScheduled = false;
  const flush = () => {
    flushScheduled = false;
    const data = pending;
    pending = "";
    if (!data) return;
    const session = useTerminalStore.getState().sessions[id];
    if (
      !session ||
      session.status === "exited" ||
      session.status === "killed" ||
      session.status === "error" ||
      session.status === "failed"
    ) {
      return;
    }
    void ptyWrite(id, data).catch((err) => {
      useTerminalStore.getState().markError(id, toAppError(err).message);
    });
  };
  terminalRegistry.ensure(id, {
    onData: (data) => {
      const session = useTerminalStore.getState().sessions[id];
      if (
        !session ||
        session.status === "exited" ||
        session.status === "killed" ||
        session.status === "error" ||
        session.status === "failed"
      ) {
        return;
      }
      pending += data;
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
  });
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: {},

  upsert: (session) =>
    set((state) => ({
      sessions: { ...state.sessions, [session.id]: { ...state.sessions[session.id], ...session } },
    })),

  registerSession: (session) => {
    set((state) => ({
      sessions: { ...state.sessions, [session.id]: { ...state.sessions[session.id], ...session } },
    }));
    bindInput(session.id);
  },

  markExited: (id, exitCode) =>
    set((state) => {
      const current = state.sessions[id];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: { ...current, status: "exited", exitCode, error: null },
        },
      };
    }),

  markError: (id, message) =>
    set((state) => {
      const current = state.sessions[id];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: { ...current, status: "error", error: message },
        },
      };
    }),

  createSession: async (request) => {
    const placeholderId = newId();
    const starting: TerminalSession = {
      id: placeholderId,
      cwd: request.cwd,
      status: "starting",
      title: request.title,
      cols: request.cols,
      rows: request.rows,
    };
    set((state) => ({ sessions: { ...state.sessions, [placeholderId]: starting } }));

    try {
      const created = await ptyCreate(request);
      const session: TerminalSession = {
        ...starting,
        ...created,
        id: created.id || placeholderId,
        cwd: created.cwd || request.cwd,
        status: created.status ?? "running",
        title: created.title ?? request.title,
      };
      set((state) => {
        const next = { ...state.sessions };
        if (session.id !== placeholderId) delete next[placeholderId];
        next[session.id] = session;
        return { sessions: next };
      });
      bindInput(session.id);
      return session;
    } catch (err) {
      const parsed = toAppError(err);
      const failed: TerminalSession = {
        ...starting,
        status: "error",
        error: isCommandMissing(parsed)
          ? "PTY backend is not available yet (pty_create)."
          : parsed.message,
      };
      set((state) => ({ sessions: { ...state.sessions, [placeholderId]: failed } }));
      return failed;
    }
  },

  // Backend ownership is independent of UI error status. Keep xterm/scrollback
  // until a replacement is accepted (or the user explicitly closes the pane).
  stopSession: async (id) => {
    try {
      await ptyClose(id);
    } catch (err) {
      const parsed = toAppError(err);
      if (parsed.code !== "SessionNotFound" && parsed.code !== "sessionNotFound") throw parsed;
    }
    clearResizeState(id);
  },

  closeSession: async (id) => {
    try {
      await get().stopSession(id);
    } catch (err) {
      get().markError(id, toAppError(err).message);
      return false;
    }
    terminalRegistry.dispose(id);
    set((state) => {
      const next = { ...state.sessions };
      delete next[id];
      return { sessions: next };
    });
    return true;
  },

  resizeSession: (id, cols, rows) => {
    const session = get().sessions[id];
    if (!session || session.status !== "running") return;
    const key = `${cols}x${rows}`;
    if (lastSize.get(id) === key) return;
    lastSize.set(id, key);
    const previous = resizeTimers.get(id);
    if (previous) clearTimeout(previous);
    resizeTimers.set(
      id,
      setTimeout(() => {
        resizeTimers.delete(id);
        void ptyResize(id, cols, rows).catch((err) => {
          const parsed = toAppError(err);
          if (!isCommandMissing(parsed)) {
            useTerminalStore.getState().markError(id, parsed.message);
          }
        });
      }, 48),
    );
  },
}));
