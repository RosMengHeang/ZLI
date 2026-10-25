import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { spawnMcpServer, startProblem, stopMcpServer } from "../spawnServer.js";
import { createToolFilter } from "./toolFilter.js";

export type StdioServerSpec = { command: string; args: string[]; env: Record<string, string> };

export type StdioRelayOptions = {
  name: string;
  spec: StdioServerSpec;
  hiddenTools?: readonly string[];
  input: NodeJS.ReadableStream;
  output: { write(line: string): unknown };
  log?: (message: string) => void;
  /** Replaces starting the real server in tests. */
  spawn?: (spec: StdioServerSpec) => ChildProcess;
};

/** How long the server gets to exit on its own after the agent closes the connection. */
const EXIT_GRACE_MS = 5_000;

/** Spec file contents: JSON with the command, args, and env that start the server. */
export function parseStdioSpec(text: string): StdioServerSpec {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The server settings are not a JSON object.");
  }
  const { command, args, env } = parsed as Record<string, unknown>;
  if (typeof command !== "string" || command.trim() === "") throw new Error("The server settings have no command.");
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("The server arguments are not a list of text values.");
  }
  const values: Record<string, string> = {};
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env)) if (typeof value === "string") values[key] = value;
  }
  return { command, args, env: values };
}

/**
 * Starts a local server and relays newline JSON-RPC between it and the agent, hiding the tools the
 * person turned off. Resolves with the exit code to use once the server has stopped.
 */
export function runStdioRelay(options: StdioRelayOptions): Promise<number> {
  const log = options.log ?? (() => undefined);
  const filter = createToolFilter(options.name, options.hiddenTools ?? []);
  let child: ChildProcess;
  try {
    child = (options.spawn ?? ((spec) => spawnMcpServer(spec, ["pipe", "pipe", "inherit"])))(options.spec);
  } catch (error) {
    log(startProblem(options.spec.command, error));
    return Promise.resolve(1);
  }
  const write = (message: unknown) => options.output.write(`${JSON.stringify(message)}\n`);

  return new Promise<number>((resolve) => {
    let settled = false;
    const fromAgent = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      fromAgent.close();
      resolve(code);
    };
    child.once("error", (error) => {
      log(startProblem(options.spec.command, error));
      finish(1);
    });
    child.once("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
    child.stdin?.on("error", () => undefined);

    if (child.stdout) {
      const fromServer = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      fromServer.on("line", (line) => {
        if (line.trim() === "") return;
        const message = parseJson(line);
        if (message === undefined) options.output.write(`${line}\n`);
        else write(filter.fromServer(message));
      });
    }

    fromAgent.on("line", (line) => {
      if (line.trim() === "") return;
      const message = parseJson(line);
      if (message === undefined) {
        child.stdin?.write(`${line}\n`);
        return;
      }
      const { forward, reply } = filter.fromClient(message);
      if (reply !== undefined) write(reply);
      if (forward !== undefined) child.stdin?.write(`${JSON.stringify(forward)}\n`);
    });
    fromAgent.once("close", () => {
      if (settled) return;
      child.stdin?.end();
      const timer = setTimeout(() => stopMcpServer(child), EXIT_GRACE_MS);
      timer.unref?.();
    });
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
