import { describe, expect, it } from "vitest";

import { conditionsTools } from "./conditions.js";

describe("mobile_device_settings", () => {
  it("lists each change on its own line", () => {
    expect(
      conditionsTools.format?.("mobiledevicesettings", {
        deviceId: "ios:UDID-1",
        done: ["Switched iPhone 16 to dark appearance.", "Granted photos to com.example.app."],
      })?.content,
    ).toEqual([{ type: "text", text: "Switched iPhone 16 to dark appearance.\nGranted photos to com.example.app." }]);
  });

  it("formats only its own action and well-formed results", () => {
    expect(conditionsTools.format?.("mobiledoctor", { done: [] })).toBeUndefined();
    expect(conditionsTools.format?.("mobiledevicesettings", { done: [1] })).toBeUndefined();
    expect(conditionsTools.tools.map((tool) => [tool.name, tool.action])).toEqual([
      ["mobile_device_settings", "mobiledevicesettings"],
    ]);
  });
});
