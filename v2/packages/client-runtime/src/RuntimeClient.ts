import {
  ClientWireMessage,
  EnvironmentId,
  RpcRequest,
  ServerWireMessage,
  type EnvironmentDescriptor,
  type RpcResponse,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import { ProjectionStore, type ProjectionListener } from "./ProjectionStore.js";

export interface RuntimeTransport {
  send(message: unknown): void;
  close(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
}

export interface RuntimeClientOptions {
  readonly token: string;
  readonly environmentId: string;
  readonly connectTransport: () => Promise<RuntimeTransport>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly reconnectDelaysMs?: readonly number[];
}

interface PendingCommand {
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
}

interface Handshake {
  readonly promise: Promise<EnvironmentDescriptor>;
  readonly resolve: (descriptor: EnvironmentDescriptor) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class RuntimeClient {
  readonly #environmentId;
  readonly #token;
  readonly #connectTransport;
  readonly #sleep;
  readonly #reconnectDelaysMs;
  readonly #store = new ProjectionStore();
  readonly #pending = new Map<string, PendingCommand>();
  #transport: RuntimeTransport | undefined;
  #removeMessageListener: (() => void) | undefined;
  #removeCloseListener: (() => void) | undefined;
  #handshake: Handshake | undefined;
  #closed = false;
  #reconnecting = false;
  #descriptor: EnvironmentDescriptor | undefined;

  private constructor(options: RuntimeClientOptions) {
    this.#environmentId = EnvironmentId.parse(options.environmentId);
    if (options.token.length === 0) throw new Error("runtime token is required");
    this.#token = options.token;
    this.#connectTransport = options.connectTransport;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [100, 500, 1_000, 2_000];
  }

  static async connect(options: RuntimeClientOptions): Promise<RuntimeClient> {
    const client = new RuntimeClient(options);
    await client.#open();
    return client;
  }

  descriptor(): EnvironmentDescriptor | undefined {
    return this.#descriptor;
  }

  projection(): RuntimeProjection | undefined {
    return this.#store.current();
  }

  subscribe(listener: ProjectionListener): () => void {
    return this.#store.subscribe(listener);
  }

  command(input: unknown): Promise<RpcResponse> {
    const request = RpcRequest.parse(input);
    const transport = this.#transport;
    if (transport === undefined || this.#handshake !== undefined) {
      return Promise.reject(new Error("runtime is not connected"));
    }
    if (this.#pending.has(request.commandId)) {
      return Promise.reject(new Error(`command ${request.commandId} is already pending`));
    }

    const pending = deferred<RpcResponse>();
    this.#pending.set(request.commandId, pending);
    transport.send(ClientWireMessage.parse({ type: "command", request }));
    return pending.promise;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("runtime client closed"));
    this.#detachListeners();
    this.#transport?.close();
    this.#transport = undefined;
  }

  async #open(): Promise<void> {
    if (this.#closed) throw new Error("runtime client is closed");
    const transport = await this.#connectTransport();
    if (this.#closed) {
      transport.close();
      return;
    }

    this.#detachListeners();
    this.#transport = transport;
    const nextHandshake = deferred<EnvironmentDescriptor>();
    this.#handshake = nextHandshake;
    this.#removeMessageListener = transport.onMessage((message) => this.#receive(transport, message));
    this.#removeCloseListener = transport.onClose(() => this.#disconnected(transport));
    transport.send(
      ClientWireMessage.parse({
        type: "hello",
        protocolVersion: 1,
        token: this.#token,
        environmentId: this.#environmentId,
      }),
    );

    const descriptor = await nextHandshake.promise;
    if (this.#transport !== transport || this.#closed) return;
    this.#descriptor = descriptor;
    this.#handshake = undefined;
    transport.send(
      ClientWireMessage.parse({
        type: "subscribe",
        afterSequence: this.#store.current()?.lastSequence ?? 0,
      }),
    );
  }

  #receive(transport: RuntimeTransport, input: unknown): void {
    if (transport !== this.#transport || this.#closed) return;
    const decoded = ServerWireMessage.safeParse(input);
    if (!decoded.success) {
      const error = new Error("invalid server message");
      this.#handshake?.reject(error);
      this.#handshake = undefined;
      transport.close();
      return;
    }

    const message = decoded.data;
    switch (message.type) {
      case "hello":
        if (message.environment.environmentId !== this.#environmentId) {
          this.#handshake?.reject(new Error("environment mismatch"));
          this.#handshake = undefined;
          transport.close();
          return;
        }
        this.#handshake?.resolve(message.environment);
        return;
      case "response": {
        const pending = this.#pending.get(message.response.commandId);
        if (pending === undefined) return;
        this.#pending.delete(message.response.commandId);
        pending.resolve(message.response);
        return;
      }
      case "projection":
        this.#store.replace(message.projection);
        return;
      case "event":
        if (this.#store.apply(message.envelope) === "gap") {
          transport.send(ClientWireMessage.parse({ type: "projection.get" }));
        }
        return;
      case "error":
        this.#handshake?.reject(new Error(message.error.message));
        this.#handshake = undefined;
        return;
    }
  }

  #disconnected(transport: RuntimeTransport): void {
    if (transport !== this.#transport || this.#closed) return;
    const error = new Error("connection closed before command completed");
    this.#handshake?.reject(error);
    this.#handshake = undefined;
    this.#rejectPending(error);
    this.#detachListeners();
    this.#transport = undefined;
    void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    if (this.#reconnecting || this.#closed) return;
    this.#reconnecting = true;
    try {
      for (const delay of this.#reconnectDelaysMs) {
        if (this.#closed) return;
        await this.#sleep(delay);
        try {
          await this.#open();
          return;
        } catch {
          // The next bounded delay is the retry policy. Commands are never replayed.
        }
      }
    } finally {
      this.#reconnecting = false;
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #detachListeners(): void {
    this.#removeMessageListener?.();
    this.#removeCloseListener?.();
    this.#removeMessageListener = undefined;
    this.#removeCloseListener = undefined;
  }
}
