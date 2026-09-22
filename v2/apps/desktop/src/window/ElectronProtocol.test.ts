import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAppAsset } from "./ElectronProtocol.js";

describe("ElectronProtocol", () => {
  it("maps only safe paths inside the renderer root", () => {
    const rendererRoot = join(tmpdir(), "zli", "renderer");
    expect(resolveAppAsset(rendererRoot, "zli-v2://app/index.html")).toBe(join(rendererRoot, "index.html"));
    expect(resolveAppAsset(rendererRoot, "zli-v2://app/assets/app.js")).toBe(join(rendererRoot, "assets", "app.js"));
  });

  it("rejects other hosts, traversal, and encoded traversal", () => {
    const rendererRoot = join(tmpdir(), "zli", "renderer");
    expect(resolveAppAsset(rendererRoot, "zli-v2://other/index.html")).toBeUndefined();
    expect(resolveAppAsset(rendererRoot, "zli-v2://app/../secret.txt")).toBeUndefined();
    expect(resolveAppAsset(rendererRoot, "zli-v2://app/%2e%2e/secret.txt")).toBeUndefined();
    expect(resolveAppAsset(rendererRoot, "https://example.com/index.html")).toBeUndefined();
  });
});
