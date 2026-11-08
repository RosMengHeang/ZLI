import { describe, expect, it } from "vitest";

import { createMobileMcpServer } from "../mcp.js";
import { workspaceText, workspaceTools } from "./workspace.js";

const workspace = {
  worktreeId: "wt-1",
  branch: "feat-cart",
  metroPort: 8142,
  emulatorPort: 5560,
  metro: { state: "free" },
  devClient: true,
  scheme: "myapp",
  openUrl: "myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8142",
  deviceId: "android-avd:Pixel_7",
} as const;

describe("mobile_workspace tool", () => {
  it("is listed read-only, and its instructions name the worktree's port variable", async () => {
    const mcp = createMobileMcpServer(async () => ({ enabled: true }));
    const init = (await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as {
      result: { instructions: string };
    };
    expect(init.result.instructions).toContain("npx expo start --port $ZLI_METRO_PORT");
    const listed = (await mcp.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
    };
    expect(listed.result.tools.find((tool) => tool.name === "mobile_workspace")).toBeDefined();
    expect(workspaceTools.tools[0]).toMatchObject({ action: "mobileworkspace", readOnly: true });
  });

  it("formats the workspace as short text", () => {
    expect(workspaceText(workspace)).toBe(
      "Metro port 8142 (free). Open with myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8142. Device: android-avd:Pixel_7. Emulators you boot use emulator-5560 when it is free.",
    );
    const other = workspaceText({
      ...workspace,
      metro: { state: "other-worktree", pid: 9, worktreeId: "wt-2", branch: "feat-login" },
      emulatorPort: undefined,
      deviceId: undefined,
    } as never);
    expect(other).toContain("Metro port 8142 (used by the worktree feat-login, pid 9).");
    expect(other).toContain("Device: none held yet");
    expect(other).toContain("Do not open this port: the app would load feat-login's bundle.");
    expect(workspaceTools.format?.("mobileworkspace", workspace)).toEqual({
      content: [{ type: "text", text: workspaceText(workspace) }],
    });
    expect(workspaceTools.format?.("mobileworkspace", { nope: true })).toBeUndefined();
    expect(workspaceTools.format?.("mobiletap", workspace)).toBeUndefined();
  });
});
