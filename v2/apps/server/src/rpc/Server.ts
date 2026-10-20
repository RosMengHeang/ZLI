import { timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ClientWireMessage,
  type EnvironmentDescriptor,
  FILE_COMMAND_TYPES,
  type FileCommand,
  FileListResult,
  FileReadResult,
  FileSearchResult,
  FileWriteResult,
  type ProviderDiscovery,
  type RpcRequest,
  type RuntimeError,
  type RuntimeProjection,
  TerminalId,
} from "@zli-v2/contracts";
import { type RawData, WebSocket, WebSocketServer } from "ws";

import { errorCode, FileService, FileServiceError } from "../files/FileService.js";
import type { Engine } from "../orchestration/Engine.js";
import { unavailableProviderDiscovery } from "../providers/discoverCliProviders.js";
import type { TerminalService, TerminalSubscription } from "../terminal/TerminalService.js";
import { AttachmentError, storeThreadAttachments } from "./attachments.js";

/** Fits thread.send with eight 10 MiB images as base64 (about 112 MB) plus the JSON envelope. */
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
/** Before hello only a small handshake is expected, so large frames are dropped without parsing them. */
const MAX_UNAUTHENTICATED_FRAME_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 5_000;

type RpcServerOptions = {
  engine: Engine;
  environment: EnvironmentDescriptor;
  token: string;
  terminalService?: TerminalService;
  fileService?: FileService;
  discoverProviders?: () => Promise<readonly ProviderDiscovery[]>;
  /** Root for uploaded thread images. Without it, image uploads are rejected. */
  attachmentsDir?: string;
  host?: string;
  port?: number;
};

export class RpcServer {
  private readonly engine: Engine;
  private readonly environment: EnvironmentDescriptor;
  private readonly token: string;
  private readonly terminalService: TerminalService | undefined;
  private readonly fileService: FileService;
  private readonly discoverProviders: RpcServerOptions["discoverProviders"];
  private readonly attachmentsDir: string | undefined;
  private readonly host: string;
  private readonly port: number;
  private httpServer: HttpServer | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private boundPort: number | undefined;
  private readonly clients = new Set<WebSocket>();
  private readonly clientCleanup = new Map<WebSocket, () => void>();

  constructor(options: RpcServerOptions) {
    if (options.token.length === 0) {
      throw new Error("RPC token is required");
    }
    this.engine = options.engine;
    this.environment = options.environment;
    this.token = options.token;
    this.terminalService = options.terminalService;
    this.fileService = options.fileService ?? new FileService();
    this.discoverProviders = options.discoverProviders;
    this.attachmentsDir = options.attachmentsDir;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
    });
    httpServer.on("upgrade", (request, socket, head) => {
      if (!isLoopback(request) || request.url !== "/rpc") {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        webSocketServer.emit("connection", client, request);
      });
    });
    webSocketServer.on("connection", (client) => this.accept(client));
    this.httpServer = httpServer;
    this.webSocketServer = webSocketServer;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("RPC server did not receive a TCP address"));
          return;
        }
        this.boundPort = (address as AddressInfo).port;
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(this.port, this.host);
    });
  }

  private async projectionSnapshot(): Promise<RuntimeProjection> {
    const projection = await this.engine.projection();
    if (!this.discoverProviders) return projection;
    try {
      return { ...projection, providers: [...(await this.discoverProviders())] };
    } catch {
      return { ...projection, providers: unavailableProviderDiscovery() };
    }
  }

  url(): string {
    if (this.boundPort === undefined) {
      throw new Error("RPC server is not started");
    }
    return `ws://${this.host}:${this.boundPort}/rpc`;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.close(1001, "server stopping");
    }
    this.clients.clear();
    for (const cleanup of this.clientCleanup.values()) cleanup();
    this.clientCleanup.clear();
    const webSocketServer = this.webSocketServer;
    const httpServer = this.httpServer;
    this.webSocketServer = undefined;
    this.httpServer = undefined;
    this.boundPort = undefined;
    if (webSocketServer) {
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }

  private accept(client: WebSocket): void {
    this.clients.add(client);
    const terminalSubscriptions = new Map<string, TerminalSubscription>();
    let authenticated = false;
    let unsubscribe: (() => void) | undefined;
    const helloTimer = setTimeout(() => {
      if (!authenticated) {
        sendError(client, { code: "unauthorized", message: "RPC hello required.", retryable: false });
        client.close(1008, "hello required");
      }
    }, HELLO_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(helloTimer);
      unsubscribe?.();
      for (const subscription of terminalSubscriptions.values()) subscription.close();
      terminalSubscriptions.clear();
      this.clients.delete(client);
      this.clientCleanup.delete(client);
    };
    this.clientCleanup.set(client, cleanup);
    client.on("close", cleanup);
    client.on("error", cleanup);
    client.on("message", (raw) => {
      void this.receive(
        client,
        raw,
        () => authenticated,
        (value) => {
          authenticated = value;
        },
        (nextUnsubscribe) => {
          unsubscribe?.();
          unsubscribe = nextUnsubscribe;
        },
        terminalSubscriptions,
      );
    });
  }

  /**
   * Keystrokes and resizes go straight to the live PTY. They are never committed to the event log,
   * which keeps typed secrets out of durable storage and keeps the log from growing per keypress.
   */
  private handleTerminalInput(client: WebSocket, request: RpcRequest): boolean {
    const command = request.command;
    if (command.type !== "terminal.write" && command.type !== "terminal.resize") return false;
    const terminalService = this.terminalService;
    if (!terminalService) return false;
    try {
      if (command.type === "terminal.write") terminalService.write(command.terminalId, command.data);
      else terminalService.resize(command.terminalId, command.cols, command.rows);
      send(client, { type: "response", response: { commandId: request.commandId, accepted: true } });
    } catch (error) {
      send(client, {
        type: "response",
        response: {
          commandId: request.commandId,
          accepted: false,
          error: {
            code: "invalid_request",
            message: error instanceof Error ? error.message : "Terminal input failed.",
            retryable: false,
          },
        },
      });
    }
    return true;
  }

  /** File reads and saves touch only the worktree on disk; contents never enter the event log. */
  private async handleFileCommand(client: WebSocket, request: RpcRequest): Promise<boolean> {
    const command = request.command;
    if (!isFileCommand(command)) return false;
    try {
      const projection = await this.engine.projection();
      const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
      if (!worktree) throw new FileServiceError("Worktree does not exist.");
      if (worktree.status !== "ready") throw new FileServiceError("Worktree is not ready.");
      const result = await this.runFileCommand(worktree.path, command);
      send(client, { type: "response", response: { commandId: request.commandId, accepted: true, result } });
    } catch (error) {
      send(client, {
        type: "response",
        response: {
          commandId: request.commandId,
          accepted: false,
          error: { code: "invalid_request", message: fileErrorMessage(command, error), retryable: false },
        },
      });
    }
    return true;
  }

  private async runFileCommand(root: string, command: FileCommand): Promise<unknown> {
    switch (command.type) {
      case "files.list":
        return FileListResult.parse(await this.fileService.list(root));
      case "files.read":
        return FileReadResult.parse(await this.fileService.read(root, command.path));
      case "files.write":
        return FileWriteResult.parse(
          await this.fileService.write(root, {
            path: command.path,
            content: command.content,
            expectedVersion: command.expectedVersion,
            ...(command.bom !== undefined ? { bom: command.bom } : {}),
            ...(command.overwrite !== undefined ? { overwrite: command.overwrite } : {}),
          }),
        );
      case "files.search":
        return FileSearchResult.parse(
          await this.fileService.search(root, command.query, {
            ...(command.caseSensitive !== undefined ? { caseSensitive: command.caseSensitive } : {}),
            ...(command.regex !== undefined ? { regex: command.regex } : {}),
            ...(command.maxResults !== undefined ? { maxResults: command.maxResults } : {}),
          }),
        );
    }
  }

  /** Image bytes are written to disk before dispatch; the command that reaches the event log carries only paths. */
  private async storeAttachments(request: RpcRequest): Promise<RpcRequest> {
    const command = request.command;
    if (command.type !== "thread.send" || !command.attachments || command.attachments.length === 0) return request;
    const attachments = await storeThreadAttachments(this.attachmentsDir, command.threadId, command.attachments);
    return { ...request, command: { ...command, attachments } };
  }

  private async receive(
    client: WebSocket,
    raw: RawData,
    isAuthenticated: () => boolean,
    setAuthenticated: (value: boolean) => void,
    setUnsubscribe: (unsubscribe: () => void) => void,
    terminalSubscriptions: Map<string, TerminalSubscription>,
  ): Promise<void> {
    const size = Array.isArray(raw)
      ? raw.reduce((total, part) => total + part.length, 0)
      : raw instanceof ArrayBuffer
        ? raw.byteLength
        : raw.length;
    if (size > (isAuthenticated() ? MAX_FRAME_BYTES : MAX_UNAUTHENTICATED_FRAME_BYTES)) {
      sendError(client, { code: "invalid_request", message: "RPC frame is too large.", retryable: false });
      client.close(1009, "frame too large");
      return;
    }
    const text = raw.toString();
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      sendError(client, { code: "invalid_request", message: "RPC frame is too large.", retryable: false });
      client.close(1009, "frame too large");
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      sendError(client, { code: "invalid_request", message: "RPC frame must be valid JSON.", retryable: false });
      client.close(1003, "invalid JSON");
      return;
    }
    const message = ClientWireMessage.safeParse(input);
    if (!message.success) {
      sendError(client, { code: "invalid_request", message: "RPC message failed validation.", retryable: false });
      return;
    }

    if (!isAuthenticated()) {
      if (message.data.type !== "hello") {
        sendError(client, { code: "unauthorized", message: "RPC hello required.", retryable: false });
        client.close(1008, "hello required");
        return;
      }
      if (!secureEqual(message.data.token, this.token)) {
        sendError(client, { code: "unauthorized", message: "Invalid RPC token.", retryable: false });
        client.close(1008, "unauthorized");
        return;
      }
      if (message.data.environmentId !== this.environment.environmentId) {
        sendError(client, { code: "environment_mismatch", message: "Wrong environment.", retryable: false });
        client.close(1008, "environment mismatch");
        return;
      }
      setAuthenticated(true);
      send(client, {
        type: "hello",
        protocolVersion: 1,
        environment: this.environment,
      });
      return;
    }

    switch (message.data.type) {
      case "command":
        if (this.terminalService && this.handleTerminalInput(client, message.data.request)) return;
        if (await this.handleFileCommand(client, message.data.request)) return;
        try {
          let request: RpcRequest;
          try {
            request = await this.storeAttachments(message.data.request);
          } catch (error) {
            if (!(error instanceof AttachmentError)) throw error;
            send(client, {
              type: "response",
              response: {
                commandId: message.data.request.commandId,
                accepted: false,
                error: { code: "invalid_request", message: error.message, retryable: false },
              },
            });
            return;
          }
          const receipt = await this.engine.dispatchPromise(request);
          if (receipt.status === "accepted") {
            send(client, {
              type: "response",
              response: {
                commandId: message.data.request.commandId,
                accepted: true,
                ...(receipt.result ? { result: receipt.result } : {}),
              },
            });
          } else {
            send(client, {
              type: "response",
              response: {
                commandId: message.data.request.commandId,
                accepted: false,
                error: {
                  code: "invalid_request",
                  message: receipt.error?.message ?? "Command rejected.",
                  retryable: false,
                },
              },
            });
          }
        } catch (error) {
          sendError(client, {
            code: "internal",
            message: error instanceof Error ? error.message : "Command failed.",
            retryable: true,
          });
        }
        return;
      case "subscribe": {
        const unsubscribe = this.engine.subscribe((event) => send(client, { type: "event", envelope: event }));
        setUnsubscribe(unsubscribe);
        try {
          send(client, { type: "projection", projection: await this.projectionSnapshot() });
          for (const event of await this.engine.eventsAfter(message.data.afterSequence)) {
            send(client, { type: "event", envelope: event });
          }
        } catch (error) {
          sendError(client, {
            code: "internal",
            message: error instanceof Error ? error.message : "Subscription failed.",
            retryable: true,
          });
        }
        return;
      }
      case "projection.get":
        send(client, { type: "projection", projection: await this.projectionSnapshot() });
        return;
      case "terminal.attach": {
        if (!this.terminalService) {
          sendError(client, { code: "unavailable", message: "Terminal streaming is unavailable.", retryable: true });
          return;
        }
        const key = message.data.terminalId as string;
        terminalSubscriptions.get(key)?.close();
        try {
          const attachment = this.terminalService.attach(TerminalId.parse(key), message.data.afterSequence);
          terminalSubscriptions.set(key, attachment.subscription);
          send(client, { type: "terminal.snapshot", snapshot: attachment.snapshot });
          void pumpTerminal(client, key, attachment.subscription, terminalSubscriptions);
        } catch (error) {
          sendError(client, {
            code: "unavailable",
            message: error instanceof Error ? error.message : "Terminal attach failed.",
            retryable: true,
          });
        }
        return;
      }
      case "hello":
        sendError(client, { code: "invalid_request", message: "RPC hello was already completed.", retryable: false });
        return;
    }
  }
}

function isFileCommand(command: RpcRequest["command"]): command is FileCommand {
  return (FILE_COMMAND_TYPES as readonly string[]).includes(command.type);
}

function fileErrorMessage(command: FileCommand, error: unknown): string {
  if (error instanceof FileServiceError) return error.message;
  const path = "path" in command ? command.path : undefined;
  const code = errorCode(error);
  if (path && code === "ENOENT") return `File not found: ${path}`;
  if (path && (code === "EACCES" || code === "EPERM")) return `Permission denied: ${path}`;
  if (path && code === "EISDIR") return `That path is a folder: ${path}`;
  if (path && (code === "EBUSY" || code === "ETXTBSY")) return `File is locked by another program: ${path}`;
  const detail = error instanceof Error ? error.message : "Unknown error.";
  const action =
    command.type === "files.write"
      ? "save"
      : command.type === "files.read"
        ? "open"
        : command.type === "files.search"
          ? "search"
          : "list";
  return `Could not ${action}${path ? ` ${path}` : " files"}: ${detail}`;
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress?.replace(/^::ffff:/u, "");
  return address === "127.0.0.1" || address === "::1";
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function send(client: WebSocket, message: unknown): void {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function sendError(client: WebSocket, error: RuntimeError): void {
  send(client, { type: "error", error });
}

async function pumpTerminal(
  client: WebSocket,
  terminalId: string,
  subscription: TerminalSubscription,
  subscriptions: Map<string, TerminalSubscription>,
): Promise<void> {
  try {
    while (subscriptions.get(terminalId) === subscription) {
      const message = await subscription.next();
      if (!message) return;
      send(client, { type: "terminal.stream", message });
      if (message.kind === "exit") return;
    }
  } finally {
    if (subscriptions.get(terminalId) === subscription) subscriptions.delete(terminalId);
    subscription.close();
  }
}
