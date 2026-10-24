type Message = Record<string, unknown>;

/** JSON-RPC "invalid params", which MCP uses for an unknown tool. */
export const HIDDEN_TOOL_CODE = -32602;

export type ClientResult = {
  /** What to pass on to the server, or undefined when nothing is left. */
  forward: unknown;
  /** What to answer the client right away, or undefined. */
  reply: unknown;
};

export type ToolFilter = {
  fromClient(message: unknown): ClientResult;
  fromServer(message: unknown): unknown;
};

export function hiddenToolMessage(tool: string, server: string): string {
  return `${tool} is turned off for ${server} in ZLI.`;
}

/**
 * Hides tools the person turned off: drops them from `tools/list` results and answers calls to them
 * without asking the server. Works on single messages and batches.
 */
export function createToolFilter(serverName: string, hiddenTools: readonly string[]): ToolFilter {
  const hidden = new Set(hiddenTools);
  const listRequests = new Set<string>();

  const clientItem = (item: unknown): { forward?: unknown; reply?: unknown } => {
    if (!isObject(item) || !isId(item.id) || typeof item.method !== "string") return { forward: item };
    if (item.method === "tools/list") {
      listRequests.add(idKey(item.id));
      return { forward: item };
    }
    if (item.method === "tools/call") {
      const name = isObject(item.params) ? item.params.name : undefined;
      if (typeof name === "string" && hidden.has(name)) {
        return {
          reply: {
            jsonrpc: "2.0",
            id: item.id,
            error: { code: HIDDEN_TOOL_CODE, message: hiddenToolMessage(name, serverName) },
          },
        };
      }
    }
    return { forward: item };
  };

  const serverItem = (item: unknown): unknown => {
    if (!isObject(item) || !isId(item.id) || "method" in item) return item;
    const key = idKey(item.id);
    if (!listRequests.has(key)) return item;
    listRequests.delete(key);
    if (!isObject(item.result) || !Array.isArray(item.result.tools)) return item;
    const tools = item.result.tools.filter((tool) => !(isObject(tool) && hidden.has(tool.name as string)));
    return { ...item, result: { ...item.result, tools } };
  };

  return {
    fromClient(message) {
      if (hidden.size === 0 && !Array.isArray(message)) return { forward: message, reply: undefined };
      if (!Array.isArray(message)) {
        const result = clientItem(message);
        return { forward: result.forward, reply: result.reply };
      }
      const forward: unknown[] = [];
      const replies: unknown[] = [];
      for (const item of message) {
        const result = clientItem(item);
        if (result.forward !== undefined) forward.push(result.forward);
        if (result.reply !== undefined) replies.push(result.reply);
      }
      return {
        forward: forward.length > 0 ? forward : undefined,
        reply: replies.length > 0 ? replies : undefined,
      };
    },
    fromServer(message) {
      if (listRequests.size === 0) return message;
      return Array.isArray(message) ? message.map(serverItem) : serverItem(message);
    },
  };
}

/** Tool names from a hide-tools file: a JSON array of strings. */
export function parseHiddenTools(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("The list of turned-off tools is not a JSON array.");
  return parsed.filter((name): name is string => typeof name === "string" && name.length > 0);
}

function isObject(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function idKey(id: string | number): string {
  return `${typeof id}:${id}`;
}
