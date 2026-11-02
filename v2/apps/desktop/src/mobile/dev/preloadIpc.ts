/** The preload's view of Electron's ipcRenderer. Preload files import only this, @zli-v2/contracts, and each other. */
export type PreloadIpc = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): () => void;
};

type SafeSchema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

/** Subscribes to a main-process event, dropping payloads that do not parse. */
export function listenParsed<T>(ipc: PreloadIpc, channel: string, schema: SafeSchema<T>) {
  return (listener: (value: T) => void): (() => void) =>
    ipc.on(channel, (_event, value) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    });
}
