import { describe, expect, it } from "vitest";

import { StructuredLogger } from "./StructuredLogger.js";

describe("StructuredLogger", () => {
  it("rotates by entry count and preserves allowlisted correlation fields", () => {
    const logger = new StructuredLogger(2, 10_000);
    logger.record("info", "first", { commandId: "command-1", threadId: "thread-1" });
    logger.record("warn", "second", { terminalId: "terminal-1" });
    logger.record("error", "third", { browserTabId: "browser-1" });

    expect(logger.snapshot()).toHaveLength(2);
    expect(logger.snapshot()[0]).toMatchObject({ message: "second", context: { terminalId: "terminal-1" } });
    expect(logger.snapshot()[1]).toMatchObject({ message: "third", context: { browserTabId: "browser-1" } });
  });

  it("rotates by bounded bytes", () => {
    const logger = new StructuredLogger(100, 400);
    logger.record("info", "a".repeat(100), { workspaceId: "workspace-1" });
    logger.record("info", "b".repeat(100), { workspaceId: "workspace-1" });
    expect(logger.snapshot()).toHaveLength(1);
    expect(logger.snapshot()[0]?.message).toBe("b".repeat(100));
  });
});
