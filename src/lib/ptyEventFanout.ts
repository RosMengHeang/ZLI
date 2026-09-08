export interface PtyLifecycleEvent {
  type: "exit" | "error" | "status";
  terminalId: string;
  message?: string;
}

export type PtyOutputListener = (terminalId: string, data: string) => void;
export type PtyLifecycleListener = (event: PtyLifecycleEvent) => void;

export interface PtyOutputFanout {
  subscribe(listener: PtyOutputListener): () => void;
  publish(terminalId: string, data: string): void;
}

export interface PtyLifecycleFanout {
  subscribe(listener: PtyLifecycleListener): () => void;
  publish(event: PtyLifecycleEvent): void;
}

function removeListener<T>(listeners: Set<T>, listener: T): void {
  listeners.delete(listener);
}

export function createPtyOutputFanout(): PtyOutputFanout {
  const listeners = new Set<PtyOutputListener>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => removeListener(listeners, listener);
    },
    publish: (terminalId, data) => {
      for (const listener of listeners) listener(terminalId, data);
    },
  };
}

export function createPtyLifecycleFanout(): PtyLifecycleFanout {
  const listeners = new Set<PtyLifecycleListener>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => removeListener(listeners, listener);
    },
    publish: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}
