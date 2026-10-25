import { isAbsolute, resolve } from "node:path";

import { MobileButton } from "@zli-v2/contracts";

import type { ZliBrowserCall } from "../browser-tool/client.js";
import { createToolServer, type McpServer, type McpTool, pickToolInput, type ToolResult } from "../browser-tool/mcp.js";

export const ZLI_MOBILE_VERSION = "1.0.0";

const PANEL =
  "ZLI's Mobile panel shows Android emulators, connected Android phones, and iOS simulators (on a Mac); the person sees the same screen you drive.";

const REF = { type: "string", description: "An element ref such as e12 from your latest mobile_snapshot." };
const COORDINATE = {
  type: "number",
  minimum: 0,
  description: "Pixels on Android, points on iOS, as mobile_snapshot reports.",
};

export const MOBILE_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "mobile_devices",
    title: "List mobile devices",
    action: "mobiledevices",
    description: `${PANEL} List every device with its deviceId, platform, state, and who is using it, plus whether Android and iOS are set up. Devices held by another agent or by the person cannot be driven until they are released.`,
    properties: {},
    readOnly: true,
  },
  {
    name: "mobile_boot",
    title: "Boot a device",
    action: "mobileboot",
    description:
      "Start an emulator or simulator and wait for it to finish booting, then show it in the Mobile panel. Without deviceId, picks a free device that is off. A cold boot can take minutes; if the result says booting, call mobile_boot again with the same deviceId.",
    properties: {
      platform: { type: "string", enum: ["android", "ios"], description: "Pick a device of this platform." },
      window: {
        type: "boolean",
        description: "Android only: also open the emulator's own window. By default it runs only in the Mobile panel.",
      },
      wipeData: { type: "boolean", description: "Android only: boot with a factory reset." },
    },
  },
  {
    name: "mobile_shutdown",
    title: "Shut down a device",
    action: "mobileshutdown",
    description: "Turn off an emulator or simulator you are using. Physical phones stay on.",
    properties: {},
  },
  {
    name: "mobile_install",
    title: "Install an app",
    action: "mobileinstall",
    description:
      "Install an app build on the device: an .apk on Android, or a simulator .app bundle on iOS. Reinstalls over an existing copy and keeps its data.",
    properties: { path: { type: "string", description: "Path to the .apk or .app, absolute or relative to cwd." } },
    required: ["path"],
  },
  {
    name: "mobile_launch",
    title: "Launch an app",
    action: "mobilelaunch",
    description: "Start an installed app by its Android package name or iOS bundle id.",
    properties: {
      appId: { type: "string", description: "For example com.example.app." },
      stop: { type: "boolean", description: "Force-stop the app first, for a fresh start." },
    },
    required: ["appId"],
  },
  {
    name: "mobile_open_url",
    title: "Open a URL on the device",
    action: "mobileopenurl",
    description:
      "Open a URL or deep link on the device, for example a page in the mobile browser, myapp://screen, or an Expo dev server at exp://localhost:8081. On Android, localhost ports are forwarded to this computer first, so a dev server on localhost works.",
    properties: { url: { type: "string", description: "http(s), exp, or an app's own URL scheme." } },
    required: ["url"],
  },
  {
    name: "mobile_snapshot",
    title: "Read the screen",
    action: "mobilesnapshot",
    description:
      "Read what is on the screen as a list of elements with text, labels, ids, and bounds. Each element has a ref such as e3 that mobile_tap and mobile_type take. Take a new snapshot after the screen changes.",
    properties: {},
    readOnly: true,
  },
  {
    name: "mobile_tap",
    title: "Tap",
    action: "mobiletap",
    description: "Tap an element by ref from mobile_snapshot, or a point by x and y.",
    properties: {
      ref: REF,
      x: COORDINATE,
      y: COORDINATE,
      longPress: { type: "boolean", description: "Hold for about a second instead of tapping." },
    },
  },
  {
    name: "mobile_swipe",
    title: "Swipe",
    action: "mobileswipe",
    description:
      'Swipe by direction across the middle of the screen, or between two points. "up" moves the finger up, which scrolls a list down.',
    properties: {
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      fromX: COORDINATE,
      fromY: COORDINATE,
      toX: COORDINATE,
      toY: COORDINATE,
      durationMs: { type: "integer", minimum: 50, maximum: 10_000, description: "Default 300." },
    },
  },
  {
    name: "mobile_type",
    title: "Type text",
    action: "mobiletype",
    description: "Type text into the focused field. Pass ref to tap a field from mobile_snapshot first.",
    properties: { text: { type: "string", description: "Up to 2000 characters." }, ref: REF },
    required: ["text"],
  },
  {
    name: "mobile_press",
    title: "Press a button",
    action: "mobilepress",
    description: "Press a hardware or system button. back and recents are Android only.",
    properties: { button: { type: "string", enum: [...MobileButton.options] } },
    required: ["button"],
  },
  {
    name: "mobile_rotate",
    title: "Rotate",
    action: "mobilerotate",
    description:
      "Rotate an Android device to an orientation, or between portrait and landscape when none is given. iOS simulators cannot be rotated from here.",
    properties: {
      orientation: { type: "string", enum: ["portrait", "landscape", "portrait-reverse", "landscape-reverse"] },
    },
  },
  {
    name: "mobile_screenshot",
    title: "Screenshot",
    action: "mobilescreenshot",
    description: "Capture the device screen as a PNG image.",
    properties: {},
    readOnly: true,
  },
  {
    name: "mobile_logs",
    title: "Read device logs",
    action: "mobilelogs",
    description: "Read recent device logs (logcat on Android, the unified log on iOS), optionally only one app's.",
    properties: {
      appId: { type: "string", description: "Only this app's lines, by package name or bundle id." },
      lines: { type: "integer", minimum: 1, maximum: 2_000, description: "How many recent lines. Default 200." },
      filter: { type: "string", description: "Only lines containing this text, ignoring case." },
    },
    readOnly: true,
  },
  {
    name: "mobile_release",
    title: "Release devices",
    action: "mobilerelease",
    description:
      "Hand back the devices you are using so other agents can drive them. Devices are also released after five minutes without an action.",
    properties: {},
  },
];

const TARGET_PROPERTIES = {
  cwd: {
    type: "string",
    description:
      "Absolute path of the directory you are working in. Picks your ZLI worktree; defaults to this tool's working directory.",
  },
  deviceId: {
    type: "string",
    description: "A deviceId from mobile_devices. Defaults to the device you used last, or a free running one.",
  },
};

export function mobileToolInput(
  tool: McpTool,
  args: Record<string, unknown>,
  cwd: () => string = () => process.cwd(),
): Record<string, unknown> {
  const input = pickToolInput(tool, args);
  if (typeof args.deviceId === "string") input.deviceId = args.deviceId;
  // The app path is read by ZLI, whose working directory is not the agent's.
  if (tool.action === "mobileinstall" && typeof input.path === "string" && !isAbsolute(input.path))
    input.path = resolve(typeof args.cwd === "string" ? args.cwd : cwd(), input.path);
  return input;
}

export function formatMobileResult(action: string, result: unknown): ToolResult {
  if (action === "mobilescreenshot" && isRecord(result) && typeof result.data === "string") {
    return {
      content: [
        {
          type: "image",
          data: result.data,
          mimeType: typeof result.mimeType === "string" ? result.mimeType : "image/png",
        },
        {
          type: "text",
          text: `Screenshot of ${String(result.name ?? "the device")}, ${String(result.width)}x${String(result.height)} px.`,
        },
      ],
    };
  }
  if (action === "mobilesnapshot" && isRecord(result) && typeof result.tree === "string") {
    const screen = isRecord(result.screen)
      ? ` Screen ${String(result.screen.width)}x${String(result.screen.height)}`
      : "";
    const header = `${String(result.deviceId)} (${String(result.platform)}).${screen} ${String(result.units)}; ${String(result.elements)} elements.`;
    return { content: [{ type: "text", text: `${header}\n${result.tree}` }] };
  }
  if (action === "mobilelogs" && isRecord(result) && typeof result.log === "string") {
    return { content: [{ type: "text", text: result.log || "(No matching log lines.)" }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
}

export function createMobileMcpServer(call: ZliBrowserCall): McpServer {
  return createToolServer(call, {
    tools: MOBILE_MCP_TOOLS,
    serverInfo: { name: "zli-mobile", title: "ZLI mobile", version: ZLI_MOBILE_VERSION },
    instructions: `${PANEL} Use mobile_devices to see what is available, mobile_boot to start a device, mobile_install and mobile_launch or mobile_open_url to run your app, then mobile_snapshot, mobile_tap, mobile_type, and mobile_screenshot to test it. Call mobile_release when you are done.`,
    targetProperties: TARGET_PROPERTIES,
    failureMessage: "The mobile action failed.",
    toInput: (tool, args) => mobileToolInput(tool, args),
    formatResult: formatMobileResult,
    // The person can turn mobile tools off; then none are listed, so agents do not try them.
    visibleTools: async () => {
      const result = (await call("mobileaccess")) as { enabled?: unknown } | null;
      return result?.enabled === false ? new Set<string>() : undefined;
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
