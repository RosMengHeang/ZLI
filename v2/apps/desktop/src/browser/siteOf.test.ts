import { describe, expect, it } from "vitest";

import { siteOf } from "./BrowserSession.js";

describe("siteOf", () => {
  it("groups a cookie's domain under its site", () => {
    expect(siteOf(".accounts.google.com")).toBe("google.com");
    expect(siteOf("www.github.com")).toBe("github.com");
    expect(siteOf("shop.example.co.uk")).toBe("example.co.uk");
    expect(siteOf("localhost")).toBe("localhost");
  });
});
