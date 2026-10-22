import { createInterface } from "node:readline";

import { BROWSER_DEVICE_PRESETS } from "@zli-v2/contracts";

import { ZliBrowserUnavailableError, type ZliBrowserCall } from "./client.js";

export const ZLI_BROWSER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

export type JsonSchema = Record<string, unknown>;

export type McpTool = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly properties: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly readOnly?: boolean;
};

const TARGET_PROPERTIES: Record<string, JsonSchema> = {
  cwd: {
    type: "string",
    description:
      "Absolute path of the directory you are working in. Picks the ZLI worktree whose browser to use; defaults to this tool's working directory.",
  },
  tabId: {
    type: "string",
    description: "A browserTabId from browser_tabs. Defaults to the tab you used last in this worktree.",
  },
};

const PANE =
  "The ZLI browser is the Chromium pane built into ZLI, the app you are running in; the user sees the same tabs.";

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: "browser_open",
    title: "Open URL in ZLI browser",
    action: "open",
    description: `${PANE} Open a URL there to load and verify the web app you are building, for example your dev server at http://localhost:3000. Reuses the tab you opened before unless newTab is true, waits for the page to load, and shows the Browser panel to the user.`,
    properties: {
      url: { type: "string", description: "http(s) URL. A bare host such as localhost:5173 gets http://." },
      newTab: { type: "boolean", description: "Open a separate tab instead of reusing your previous one." },
    },
    required: ["url"],
  },
  {
    name: "browser_navigate",
    title: "Navigate ZLI browser tab",
    action: "navigate",
    description: `${PANE} Load a different URL in the current tab and wait for it to finish loading.`,
    properties: { url: { type: "string", description: "http(s) URL to load." } },
    required: ["url"],
  },
  {
    name: "browser_back",
    title: "Go back",
    action: "back",
    description: "Go back one page in the current ZLI browser tab's history.",
    properties: {},
  },
  {
    name: "browser_forward",
    title: "Go forward",
    action: "forward",
    description: "Go forward one page in the current ZLI browser tab's history.",
    properties: {},
  },
  {
    name: "browser_reload",
    title: "Reload page",
    action: "reload",
    description: "Reload the current ZLI browser tab, for example after changing code without hot reload.",
    properties: { hard: { type: "boolean", description: "Bypass the HTTP cache." } },
  },
  {
    name: "browser_tabs",
    title: "List browser tabs",
    action: "tabs",
    description: `${PANE} List the browser tabs open for your worktree, including which one the other tools use by default.`,
    properties: {},
    readOnly: true,
  },
  {
    name: "browser_snapshot",
    title: "Read page structure",
    action: "snapshot",
    description:
      "Read the current page in the ZLI browser: URL, title, visible text, and interactive elements. Each element has a CSS selector you can pass to browser_click and browser_fill. Prefer this over screenshots for finding things to interact with.",
    properties: {},
    readOnly: true,
  },
  {
    name: "browser_click",
    title: "Click element",
    action: "click",
    description:
      "Click an element in the ZLI browser with real mouse input. Pass a CSS selector from browser_snapshot, visible text such as a button label, or x and y page coordinates in CSS pixels.",
    properties: {
      selector: { type: "string", description: "CSS selector of the element to click." },
      text: { type: "string", description: "Visible text or accessible label of the element to click." },
      x: { type: "number", description: "Horizontal position in CSS pixels from the viewport's left edge." },
      y: { type: "number", description: "Vertical position in CSS pixels from the viewport's top edge." },
    },
  },
  {
    name: "browser_fill",
    title: "Fill field",
    action: "fill",
    description:
      "Replace the value of a text field, textarea, select, or editable region in the ZLI browser. Typing triggers the page's input events.",
    properties: {
      selector: { type: "string", description: "CSS selector of the field." },
      value: { type: "string", description: "Text to enter, or the option value or label for a select." },
    },
    required: ["selector", "value"],
  },
  {
    name: "browser_press",
    title: "Press key",
    action: "press",
    description:
      "Press a key in the focused element of the ZLI browser, such as Enter, Tab, Escape, ArrowDown, or a chord like Control+A.",
    properties: { key: { type: "string", description: "Key name or chord." } },
    required: ["key"],
  },
  {
    name: "browser_wait",
    title: "Wait for page",
    action: "wait",
    description:
      "Wait until a CSS selector is visible in the ZLI browser, or, without a selector, until network requests have been idle for idleMs.",
    properties: {
      selector: { type: "string", description: "CSS selector to wait for." },
      idleMs: {
        type: "integer",
        minimum: 0,
        maximum: 10000,
        description: "Quiet period for network idle. Default 500.",
      },
      timeoutMs: { type: "integer", minimum: 1, maximum: 120000, description: "Give up after this long." },
    },
  },
  {
    name: "browser_evaluate",
    title: "Run JavaScript",
    action: "evaluate",
    description:
      "Evaluate a JavaScript expression in the page open in the ZLI browser and return its JSON value. Promises are awaited. Use it to read app state or check the DOM.",
    properties: {
      expression: { type: "string", description: "Expression to evaluate, for example document.title." },
      timeoutMs: { type: "integer", minimum: 100, maximum: 60000, description: "Default 10000." },
    },
    required: ["expression"],
  },
  {
    name: "browser_screenshot",
    title: "Take screenshot",
    action: "screenshot",
    description:
      "Capture what the page in the ZLI browser looks like, at the emulated device size when a viewport is set. Use it to check layout and styling visually.",
    properties: {
      fullPage: { type: "boolean", description: "Capture the whole scrollable page instead of the visible area." },
      format: { type: "string", enum: ["png", "jpeg"], description: "Default png." },
    },
    readOnly: true,
  },
  {
    name: "browser_console",
    title: "Read console",
    action: "console",
    description:
      "Read console messages and uncaught exceptions from the page in the ZLI browser. Check this after loading or interacting with your app.",
    properties: { clear: { type: "boolean", description: "Clear the stored messages after reading them." } },
  },
  {
    name: "browser_network",
    title: "Read network requests",
    action: "network",
    description: "List recent network requests made by the page in the ZLI browser, with status codes and failures.",
    properties: {},
    readOnly: true,
  },
  {
    name: "browser_viewport",
    title: "Emulate device",
    action: "viewport",
    description: `Emulate a device screen in the ZLI browser to test responsive layouts: pass a preset (${BROWSER_DEVICE_PRESETS.map((preset) => `${preset.id} ${preset.width}x${preset.height}`).join(", ")}), a custom width and height, or reset to fill the pane again. The user sees the emulated device too. Reload if the page detects devices by user agent.`,
    properties: {
      preset: { type: "string", enum: BROWSER_DEVICE_PRESETS.map((preset) => preset.id) },
      width: { type: "integer", minimum: 200, maximum: 4000, description: "CSS pixels." },
      height: { type: "integer", minimum: 200, maximum: 4000, description: "CSS pixels." },
      mobile: { type: "boolean", description: "Mobile viewport rules, touch, and a phone user agent." },
      deviceScaleFactor: { type: "number", minimum: 1, maximum: 4 },
      reset: { type: "boolean", description: "Stop emulating and fill the pane." },
    },
  },
  {
    name: "browser_close",
    title: "Close tab",
    action: "close",
    description: "Close the current ZLI browser tab.",
    properties: {},
  },
];

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
export type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

export type McpServer = { handleMessage(message: unknown): Promise<unknown | undefined> };

/** One MCP server built on the ZLI control service: its tools, how it describes itself, and how it answers. */
export type ToolServerDefinition = {
  readonly tools: readonly McpTool[];
  readonly serverInfo: { name: string; title: string; version: string };
  readonly instructions: string;
  /** Properties every tool accepts, such as cwd. */
  readonly targetProperties: Record<string, JsonSchema>;
  readonly failureMessage: string;
  readonly toInput?: (tool: McpTool, args: Record<string, unknown>) => Record<string, unknown>;
  readonly formatResult?: (action: string, result: unknown) => ToolResult;
  /** Names of the tools to list right now. Every tool is listed when this resolves undefined. */
  readonly visibleTools?: () => Promise<ReadonlySet<string> | undefined>;
};

export function createMcpServer(call: ZliBrowserCall): McpServer {
  return createToolServer(call, {
    tools: MCP_TOOLS,
    serverInfo: { name: "zli-browser", title: "ZLI browser", version: ZLI_BROWSER_VERSION },
    instructions: `${PANE} Use browser_open to load the web app you are working on, then browser_snapshot, browser_screenshot, and browser_console to verify it. browser_viewport emulates phones and tablets.`,
    targetProperties: TARGET_PROPERTIES,
    failureMessage: "The browser action failed.",
    toInput: (tool, args) => {
      const input = pickToolInput(tool, args);
      if (typeof args.tabId === "string") input.browserTabId = args.tabId;
      return input;
    },
    formatResult,
  });
}

/** The arguments a tool declares, plus cwd. */
export function pickToolInput(tool: McpTool, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of [...Object.keys(tool.properties), "cwd"]) if (args[key] !== undefined) input[key] = args[key];
  return input;
}

export function createToolServer(call: ZliBrowserCall, definition: ToolServerDefinition): McpServer {
  const tools = new Map(definition.tools.map((tool) => [tool.name, tool]));
  const toInput = definition.toInput ?? pickToolInput;
  const format = definition.formatResult ?? formatResult;

  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = tools.get(name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
    try {
      return format(tool.action, await call(tool.action, toInput(tool, args)));
    } catch (cause) {
      const message =
        cause instanceof ZliBrowserUnavailableError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : definition.failureMessage;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };

  const listTools = async () => {
    let visible: ReadonlySet<string> | undefined;
    try {
      visible = await definition.visibleTools?.();
    } catch {
      visible = undefined;
    }
    return definition.tools.filter((tool) => !visible || visible.has(tool.name));
  };

  const handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: definition.serverInfo,
          instructions: definition.instructions,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: (await listTools()).map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: {
              type: "object",
              properties: { ...tool.properties, ...definition.targetProperties },
              ...(tool.required ? { required: [...tool.required] } : {}),
              additionalProperties: false,
            },
            annotations: { title: tool.title, readOnlyHint: tool.readOnly === true, openWorldHint: true },
          })),
        };
      case "tools/call": {
        if (!isRecord(params) || typeof params.name !== "string")
          throw new RpcError(-32602, "tools/call needs a tool name.");
        return callTool(params.name, isRecord(params.arguments) ? params.arguments : {});
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  };

  const handleOne = async (message: unknown): Promise<unknown | undefined> => {
    if (!isRecord(message) || typeof (message as JsonRpcMessage).method !== "string") {
      if (isRecord(message) && ("result" in message || "error" in message)) return undefined;
      return rpcError(isRecord(message) ? toId(message.id) : null, -32600, "Invalid request.");
    }
    const { id, method, params } = message as JsonRpcMessage & { method: string };
    const isNotification = id === undefined;
    try {
      const result = await handleRequest(method, params);
      return isNotification ? undefined : { jsonrpc: "2.0", id: toId(id), result };
    } catch (cause) {
      if (isNotification) return undefined;
      if (cause instanceof RpcError) return rpcError(toId(id), cause.code, cause.message);
      return rpcError(toId(id), -32603, cause instanceof Error ? cause.message : "Internal error.");
    }
  };

  return {
    handleMessage: async (message) => {
      if (Array.isArray(message)) {
        const responses = (await Promise.all(message.map(handleOne))).filter((response) => response !== undefined);
        return responses.length > 0 ? responses : undefined;
      }
      if (isRecord(message) && message.method === "notifications/initialized") return undefined;
      return handleOne(message);
    },
  };
}

/** Serves newline-delimited JSON-RPC. Resolves when stdin closes; never throws on bad input. */
export async function serveMcpOverStdio(
  server: McpServer,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Set<Promise<void>>();
  const write = (value: unknown) => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed) as unknown;
    } catch {
      write(rpcError(null, -32700, "Parse error."));
      continue;
    }
    const task = server
      .handleMessage(message)
      .then((response) => {
        if (response !== undefined) write(response);
      })
      .catch(() => undefined)
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}

function formatResult(action: string, result: unknown): ToolResult {
  if (action === "screenshot" && isRecord(result) && typeof result.data === "string") {
    const size =
      typeof result.width === "number" && typeof result.height === "number"
        ? `, ${result.width}x${result.height} px`
        : "";
    return {
      content: [
        {
          type: "image",
          data: result.data,
          mimeType: typeof result.mimeType === "string" ? result.mimeType : "image/png",
        },
        { type: "text", text: `Screenshot of ${String(result.url ?? "the page")}${size}.` },
      ],
    };
  }
  const loadError = isRecord(result) && isRecord(result.tab) ? result.tab.loadError : undefined;
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
    ...(typeof loadError === "string" ? { isError: true } : {}),
  };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
