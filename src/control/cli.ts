import {
  CONTROL_PROTOCOL_VERSION,
  type ControlMethod,
  type ControlRequest,
} from "./protocol.ts";

export interface ParsedCli {
  json: boolean;
  request: ControlRequest<Record<string, unknown>>;
}

export function parseCli(argv: string[], environment: { projectId?: string } = {}): ParsedCli {
  const args = [...argv];
  const json = args[0] === "--json" || args[args.length - 1] === "--json";
  if (args[0] === "--json") args.shift();
  if (args[args.length - 1] === "--json") args.pop();
  const [group, action, ...rest] = args;
  const [method, params] = command(group, action, rest, environment);
  return {
    json,
    request: {
      id: requestId(),
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      method,
      params,
      timeoutMs: 30_000,
    },
  };
}

function command(
  group: string | undefined,
  action: string | undefined,
  args: string[],
  environment: { projectId?: string },
): [ControlMethod, Record<string, unknown>] {
  if (group === "status") return ["session.list", {}];
  if (group === "agents") return ["agent.list", {}];
  if (group === "attention") return ["attention.list", {}];
  if (group === "agent") {
    if (action === "list") return ["agent.list", {}];
    if (action === "send") {
      const [agentId, ...message] = args;
      required(agentId, "Agent ID is required");
      required(message.join(" "), "Message is required");
      return ["agent.send", { agentId, body: message.join(" ") }];
    }
    if (action === "spawn") {
      if (args.includes("--provider") || args.includes("--task")) {
        const projectId = option(args, "--project") ?? environment.projectId;
        const providerId = option(args, "--provider");
        const task = option(args, "--task");
        const name = option(args, "--name");
        required(projectId, "Project is required");
        required(providerId, "Provider is required");
        required(task, "Task is required");
        return ["agent.spawn", { projectId, providerId, task, ...(name ? { name } : {}) }];
      }
      const [projectId, providerId, ...task] = args;
      required(projectId, "Project is required");
      required(providerId, "Provider is required");
      required(task.join(" "), "Task is required");
      return ["agent.spawn", { projectId, providerId, task: task.join(" ") }];
    }
    if (["read", "focus", "pause", "stop"].includes(action ?? "")) {
      required(args[0], "Agent ID is required");
      return [`agent.${action}` as ControlMethod, { agentId: args[0] }];
    }
  }
  if (group === "session") {
    if (action === "list") return ["session.list", {}];
    if (action === "resume") {
      required(args[0], "Session ID is required");
      return ["session.resume", { sessionId: args[0] }];
    }
  }
  if (group === "browser") {
    if (action === "list") return ["browser.list", {}];
    if (action === "open" || action === "navigate") {
      required(args[0], "URL is required");
      return [`browser.${action}` as ControlMethod, { url: args[0] }];
    }
  }
  if (group === "taxchat" && action === "send") {
    required(args.join(" "), "Message is required");
    return ["taxchat.send", { body: args.join(" ") }];
  }
  throw new Error(`Unknown command: ${[group, action].filter(Boolean).join(" ") || "(empty)"}`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(value: string | undefined, message: string): asserts value is string {
  if (!value?.trim()) throw new Error(message);
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}`;
}
