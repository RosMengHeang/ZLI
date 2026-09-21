import { describe, expect, it } from "vitest";

import { resolveAppAsset } from "./ElectronProtocol.js";

describe("ElectronProtocol", () => {
  it("maps only safe paths inside the renderer root", () => {
    expect(resolveAppAsset("C:\\zli\\renderer", "zli-v2://app/index.html")).toBe("C:\\zli\\renderer\\index.html");
    expect(resolveAppAsset("C:\\zli\\renderer", "zli-v2://app/assets/app.js")).toBe("C:\\zli\\renderer\\assets\\app.js");
  });

  it("rejects other hosts, traversal, and encoded traversal", () => {
    expect(resolveAppAsset("C:\\zli\\renderer", "zli-v2://other/index.html")).toBeUndefined();
    expect(resolveAppAsset("C:\\zli\\renderer", "zli-v2://app/../secret.txt")).toBeUndefined();
    expect(resolveAppAsset("C:\\zli\\renderer", "zli-v2://app/%2e%2e/secret.txt")).toBeUndefined();
    expect(resolveAppAsset("C:\\zli\\renderer", "https://example.com/index.html")).toBeUndefined();
  });
});
