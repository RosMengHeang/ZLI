import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseMobileArgs, runMobileCli } from "./cli.js";
import { createMobileMcpServer, MOBILE_MCP_TOOLS, mobileToolInput } from "./mcp.js";

type Calls = Array<{ action: string; input: Record<string, unknown> | undefined }>;

function server(answer: (action: string, input?: Record<string, unknown>) => unknown) {
  const calls: Calls = [];
  const mcp = createMobileMcpServer(async (action, input) => {
    calls.push({ action, input });
    return answer(action, input);
  });
  const request = (method: string, params?: unknown) =>
    mcp.handleMessage({ jsonrpc: "2.0", id: 1, method, params }) as Promise<{
      result: Record<string, unknown> & { tools?: Array<{ name: string }>; content?: Array<Record<string, unknown>> };
    }>;
  return { calls, request };
}

describe("zli-mobile MCP server", () => {
  it("names itself zli-mobile and lists every mobile tool", async () => {
    const { request } = server(() => ({ enabled: true }));
    const init = await request("initialize", { protocolVersion: "2025-06-18" });
    expect((init.result.serverInfo as { name: string }).name).toBe("zli-mobile");
    const listed = await request("tools/list");
    expect(listed.result.tools?.map((tool) => tool.name)).toEqual([
      "mobile_devices",
      "mobile_boot",
      "mobile_shutdown",
      "mobile_install",
      "mobile_launch",
      "mobile_open_url",
      "mobile_snapshot",
      "mobile_tap",
      "mobile_swipe",
      "mobile_type",
      "mobile_press",
      "mobile_rotate",
      "mobile_screenshot",
      "mobile_logs",
      "mobile_release",
    ]);
  });

  it("lists no tools when the person turned mobile tools off", async () => {
    const { request } = server(() => ({ enabled: false }));
    expect((await request("tools/list")).result.tools).toEqual([]);
  });

  it("passes deviceId through and returns screenshots as images", async () => {
    const { request, calls } = server(() => ({
      deviceId: "android-avd:Pixel_7",
      name: "Pixel 7",
      mimeType: "image/png",
      width: 1080,
      height: 2400,
      data: "cG5n",
    }));
    const result = await request("tools/call", {
      name: "mobile_screenshot",
      arguments: { deviceId: "android-avd:Pixel_7", cwd: "/repo/app" },
    });
    expect(calls).toEqual([
      { action: "mobilescreenshot", input: { cwd: "/repo/app", deviceId: "android-avd:Pixel_7" } },
    ]);
    expect(result.result.content?.[0]).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
    expect(result.result.content?.[1]?.text).toBe("Screenshot of Pixel 7, 1080x2400 px.");
  });

  it("prints the snapshot tree as text and reports failures as tool errors", async () => {
    const { request } = server((action) => {
      if (action === "mobiletap") throw new Error("Call mobile_snapshot first; refs come from the latest snapshot.");
      return { deviceId: "ios:1", platform: "ios", units: "points", elements: 1, tree: '[e1] button "Sign in"' };
    });
    const snapshot = await request("tools/call", { name: "mobile_snapshot", arguments: {} });
    expect(snapshot.result.content?.[0]?.text).toBe('ios:1 (ios). points; 1 elements.\n[e1] button "Sign in"');
    const tap = await request("tools/call", { name: "mobile_tap", arguments: { ref: "e1" } });
    expect(tap.result.isError).toBe(true);
    expect(tap.result.content?.[0]?.text).toMatch(/Call mobile_snapshot first/u);
  });

  it("resolves a relative install path against the agent's cwd", () => {
    const install = MOBILE_MCP_TOOLS.find((tool) => tool.name === "mobile_install");
    if (!install) throw new Error("mobile_install is missing");
    expect(mobileToolInput(install, { path: "build/app.apk", cwd: "/repo/app" })).toEqual({
      path: resolve("/repo/app", "build/app.apk"),
      cwd: "/repo/app",
    });
  });
});

describe("zli-mobile command line", () => {
  it("parses taps, swipes, and device options", () => {
    expect(parseMobileArgs(["tap", "e4", "--device", "ios:1", "--long"])).toEqual({
      kind: "call",
      action: "mobiletap",
      input: { deviceId: "ios:1", ref: "e4", longPress: true },
    });
    expect(parseMobileArgs(["tap", "--x", "10", "--y", "20"])).toMatchObject({ input: { x: 10, y: 20 } });
    expect(parseMobileArgs(["swipe", "--from", "500,1500", "--to", "500,500", "--duration", "400"])).toMatchObject({
      input: { fromX: 500, fromY: 1500, toX: 500, toY: 500, durationMs: 400 },
    });
    expect(parseMobileArgs(["install", "app.apk"], () => "/repo/app")).toMatchObject({
      input: { path: resolve("/repo/app", "app.apk") },
    });
    expect(() => parseMobileArgs(["tap"])).toThrow(/needs a ref/u);
    expect(() => parseMobileArgs(["swipe", "--from", "1"])).toThrow(/x,y/u);
  });

  it("writes screenshots to a file and prints the path", async () => {
    const written: Array<{ path: string; data: string }> = [];
    const output: string[] = [];
    const code = await runMobileCli(
      { kind: "call", action: "mobilescreenshot", input: {}, screenshotPath: "shot.png" },
      async () => ({ data: Buffer.from("png").toString("base64") }),
      {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
        cwd: () => "/repo/app",
        writeFile: async (path, data) => {
          written.push({ path, data: data.toString("utf8") });
        },
      },
    );
    expect(code).toBe(0);
    const shot = resolve("/repo/app", "shot.png");
    expect(written).toEqual([{ path: shot, data: "png" }]);
    expect(output).toEqual([`${shot}\n`]);
  });
});
