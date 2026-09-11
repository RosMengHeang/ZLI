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
  if (group === "attention") {
    if (!action || action === "list") return ["attention.list", {}];
    if (action === "ack") {
      const projectId = option(args, "--project") ?? environment.projectId;
      const agentId = positional(args)[0];
      required(projectId, "Project is required");
      required(agentId, "Agent ID is required");
      return ["attention.ack", { projectId, agentId }];
    }
  }
  if (group === "agent") {
    if (action === "list") return ["agent.list", {}];
    if (action === "queue") {
      const projectId = option(args, "--project") ?? environment.projectId;
      return ["agent.queue_status", projectId ? { projectId } : {}];
    }
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
  if (group === "worktree" && action === "audit") {
    const projectId = option(args, "--project") ?? environment.projectId;
    required(projectId, "Project is required");
    return ["worktree.audit", { projectId }];
  }
  if (group === "session") {
    if (action === "list") return ["session.list", {}];
    if (action === "reconcile") return ["session.reconcile", {}];
    if (action === "resume") {
      required(args[0], "Session ID is required");
      return ["session.resume", { sessionId: args[0] }];
    }
  }
  if (group === "doctor") return ["session.reconcile", {}];
  if (group === "browser") {
    if (action === "list") return ["browser.list", {}];
    if (action === "open") {
      const projectId = option(args, "--project") ?? environment.projectId;
      const url = option(args, "--url") ?? positional(args)[0];
      required(projectId, "Project is required");
      required(url, "URL is required");
      return ["browser.open", { projectId, url }];
    }
    const values = positional(args);
    const surfaceId = values[0];
    if (["navigate", "wait", "snapshot", "click", "fill", "press", "eval", "console", "errors", "screenshot"].includes(action ?? "")) required(surfaceId, "Surface ID is required");
    if (action === "navigate") {
      required(values[1], "URL is required");
      return ["browser.navigate", { surfaceId, url: values[1] }];
    }
    if (action === "snapshot") {
      const depth = option(args, "--depth");
      const selector = option(args, "--selector");
      return ["browser.snapshot", { surfaceId, ...(selector ? { selector } : {}), ...(depth ? { maxDepth: positiveInteger(depth, "Depth") } : {}) }];
    }
    if (action === "click") {
      const selector = option(args, "--selector") ?? values[1];
      required(selector, "Selector is required");
      return ["browser.click", { surfaceId, selector }];
    }
    if (action === "fill") {
      const selector = option(args, "--selector") ?? values[1];
      const text = option(args, "--text") ?? values.slice(2).join(" ");
      required(selector, "Selector is required");
      return ["browser.fill", { surfaceId, selector, text }];
    }
    if (action === "press") {
      required(values[1], "Key is required");
      return ["browser.press", { surfaceId, key: values[1] }];
    }
    if (action === "eval") {
      const script = option(args, "--script") ?? values.slice(1).join(" ");
      required(script, "Script is required");
      return ["browser.eval", { surfaceId, script }];
    }
    if (action === "wait") {
      const timeoutMs = positiveInteger(option(args, "--timeout") ?? "30000", "Timeout");
      const selector = option(args, "--selector");
      const url = option(args, "--url");
      const load = option(args, "--load");
      const state = option(args, "--state");
      const condition = selector
        ? { kind: "selector", selector, ...(state ? { state } : {}) }
        : url ? { kind: "url", url }
          : load ? { kind: "load", state: load }
            : null;
      if (!condition) throw new Error("Wait condition is required");
      return ["browser.wait", { surfaceId, condition, timeoutMs }];
    }
    if (["console", "errors", "screenshot"].includes(action ?? "")) return [`browser.${action}` as ControlMethod, { surfaceId }];
  }
  if (group === "taxchat" && action === "send") {
    const projectId = option(args, "--project") ?? environment.projectId;
    const body = positional(args).join(" ");
    const recipientIds = optionValues(args, "--to");
    required(projectId, "Project is required");
    required(body, "Message is required");
    return ["taxchat.send", { projectId, body, ...(recipientIds.length ? { recipientIds } : {}) }];
  }
  throw new Error(`Unknown command: ${[group, action].filter(Boolean).join(" ") || "(empty)"}`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function optionValues(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function required(value: string | undefined, message: string): asserts value is string {
  if (!value?.trim()) throw new Error(message);
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}`;
}
