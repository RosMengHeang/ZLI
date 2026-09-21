export type ElectronDebuggerLike = {
  attach(version?: string): Promise<void> | void;
  detach(): Promise<void> | void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
  removeListener(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
};

export class CdpSession {
  readonly #listeners = new Set<(method: string, params: unknown) => void>();
  readonly #messageListener = (_event: unknown, method: string, params: unknown) => {
    for (const listener of this.#listeners) listener(method, params);
  };
  #started = false;

  constructor(private readonly debuggerLike: ElectronDebuggerLike) {}

  async start(): Promise<void> {
    if (this.#started) return;
    await this.debuggerLike.attach("1.3");
    this.debuggerLike.on("message", this.#messageListener);
    await this.debuggerLike.sendCommand("Browser.getVersion");
    this.#started = true;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.start();
    return this.debuggerLike.sendCommand(method, params);
  }

  onMessage(listener: (method: string, params: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.debuggerLike.removeListener("message", this.#messageListener);
    this.#listeners.clear();
    this.#started = false;
    await this.debuggerLike.detach();
  }
}
