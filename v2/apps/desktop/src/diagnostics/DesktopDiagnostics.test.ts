import { describe, expect, it } from "vitest";

import { DesktopDiagnostics } from "./DesktopDiagnostics.js";

describe("DesktopDiagnostics", () => {
  it("keeps renderer operation metadata bounded", () => {
    const diagnostics = new DesktopDiagnostics(2, 10_000);
    diagnostics.record("info", "renderer command received", { commandId: "command-1", workspaceId: "workspace-1" });
    diagnostics.record("warn", "browser operation failed", { browserTabId: "browser-1" });
    diagnostics.record("error", "server reconnect requested", { workspaceId: "workspace-1" });

    expect(diagnostics.snapshot()).toHaveLength(2);
    expect(diagnostics.snapshot()[0]).toMatchObject({ message: "browser operation failed" });
    expect(diagnostics.snapshot()[1]).toMatchObject({ message: "server reconnect requested" });
  });
});
