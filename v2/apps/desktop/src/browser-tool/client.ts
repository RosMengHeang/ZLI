import { readFile } from "node:fs/promises";
import { request } from "node:http";

import { BrowserControlEndpoint } from "@zli-v2/contracts";

export const ZLI_NOT_RUNNING_MESSAGE = "ZLI is not running, so its browser is unavailable.";

/** ZLI is closed, restarting, or this process was not started by ZLI. */
export class ZliBrowserUnavailableError extends Error {
  constructor(message = ZLI_NOT_RUNNING_MESSAGE) {
    super(message);
    this.name = "ZliBrowserUnavailableError";
  }
}

export type ZliBrowserCall = (action: string, input?: Record<string, unknown>) => Promise<unknown>;

export type ZliBrowserPost = (
  endpoint: BrowserControlEndpoint,
  action: string,
  body: string,
) => Promise<{ status: number; body: string }>;

export type ZliBrowserClientOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: () => string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly post?: ZliBrowserPost;
  /** Shown when ZLI cannot be reached. Defaults to the browser wording. */
  readonly notRunningMessage?: string;
  /** Names the service in errors, for example "the ZLI browser". */
  readonly serviceName?: string;
};

/** Every call re-reads the endpoint file, because each ZLI launch picks a new port and token. */
export function createZliBrowserClient(options: ZliBrowserClientOptions = {}): ZliBrowserCall {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? (() => process.cwd());
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const alive = options.isProcessAlive ?? isProcessAlive;
  const post = options.post ?? postJson;
  const notRunning = options.notRunningMessage ?? ZLI_NOT_RUNNING_MESSAGE;
  const service = options.serviceName ?? "the ZLI browser";
  const Service = service.charAt(0).toUpperCase() + service.slice(1);
  return async (action, input = {}) => {
    const controlFile = env.ZLI_BROWSER_CONTROL_FILE;
    if (!controlFile)
      throw new ZliBrowserUnavailableError(
        `${notRunning} (ZLI_BROWSER_CONTROL_FILE is not set; run this from an agent or terminal that ZLI started.)`,
      );
    let endpoint: BrowserControlEndpoint;
    try {
      endpoint = BrowserControlEndpoint.parse(JSON.parse(await read(controlFile)));
    } catch {
      throw new ZliBrowserUnavailableError(notRunning);
    }
    if (!alive(endpoint.pid)) throw new ZliBrowserUnavailableError(notRunning);
    const body: Record<string, unknown> = { ...withoutUndefined(input) };
    if (body.cwd === undefined) body.cwd = cwd();
    if (env.ZLI_WORKTREE_ID && body.defaultWorktreeId === undefined) body.defaultWorktreeId = env.ZLI_WORKTREE_ID;
    let response: { status: number; body: string };
    try {
      response = await post(endpoint, action, JSON.stringify(body));
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE")
        throw new ZliBrowserUnavailableError(notRunning);
      throw new Error(`Could not reach ${service}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let parsed: { ok?: unknown; result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
      throw new Error(`${Service} sent an unreadable response (HTTP ${response.status}).`);
    }
    if (response.status === 401) throw new ZliBrowserUnavailableError(`${notRunning} (The endpoint file is stale.)`);
    if (parsed.ok !== true)
      throw new Error(typeof parsed.error === "string" ? parsed.error : `${Service} failed (HTTP ${response.status}).`);
    return parsed.result;
  };
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

const postJson: ZliBrowserPost = (endpoint, action, body) =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        path: `/v1/${encodeURIComponent(action)}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: 170_000,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("The ZLI browser did not answer in time.")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
