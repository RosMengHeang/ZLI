import { describe, expect, it } from "vitest";

import { ClientControl, isControlType } from "./messages.js";

const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

describe("ClientControl", () => {
  it("accepts a push token or a null one, with the platform", () => {
    expect(ClientControl.parse({ type: "gateway.push", token, platform: "ios" })).toEqual({
      type: "gateway.push",
      token,
      platform: "ios",
    });
    expect(
      ClientControl.parse({ type: "gateway.push", token: "ExpoPushToken[abc-123_x]", platform: "android" }),
    ).toBeTruthy();
    expect(ClientControl.parse({ type: "gateway.push", token: null, platform: "android" })).toMatchObject({
      token: null,
    });
  });

  it("refuses anything that is not an Expo push token", () => {
    for (const bad of [
      "",
      "https://example.com/hook",
      "ExponentPushToken[]",
      `ExponentPushToken[${"a".repeat(200)}]`,
    ]) {
      expect(ClientControl.safeParse({ type: "gateway.push", token: bad, platform: "ios" }).success).toBe(false);
    }
    expect(ClientControl.safeParse({ type: "gateway.push", token, platform: "web" }).success).toBe(false);
    expect(ClientControl.safeParse({ type: "gateway.push", platform: "ios" }).success).toBe(false);
  });

  it("accepts away with a boolean only", () => {
    expect(ClientControl.parse({ type: "gateway.away", away: true })).toEqual({ type: "gateway.away", away: true });
    expect(ClientControl.safeParse({ type: "gateway.away", away: "yes" }).success).toBe(false);
    expect(isControlType("gateway.away")).toBe(true);
  });
});
