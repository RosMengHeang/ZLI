import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandId } from "@zli-v2/contracts";
import { makeCommandId } from "./commandId.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeCommandId", () => {
  it("creates unique valid command IDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", undefined);

    const first = makeCommandId();
    const second = makeCommandId();

    expect(CommandId.safeParse(first).success).toBe(true);
    expect(CommandId.safeParse(second).success).toBe(true);
    expect(second).not.toBe(first);
  });
});
