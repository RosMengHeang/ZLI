import { describe, expect, it } from "vitest";

import type { PreloadIpc } from "../preloadIpc.js";
import { createConditionsApi } from "./preload.js";

function ipc(answer: unknown) {
  const calls: { channel: string; payload: unknown }[] = [];
  const fake: PreloadIpc = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return answer;
    },
    on: () => () => {},
  };
  return { fake, calls };
}

describe("the device settings preload API", () => {
  it("sends checked input on fixed channels and parses the answer", async () => {
    const { fake, calls } = ipc({ message: "Done." });
    const { conditions } = createConditionsApi(fake);
    expect(await conditions.setAppearance("ios:UDID-1", "dark")).toEqual({ message: "Done." });
    await conditions.setLocation("ios:UDID-1", { latitude: 1.5, longitude: -2 });
    await conditions.setPermission("ios:UDID-1", { appId: "com.example.app", permission: "photos", grant: true });
    expect(calls).toEqual([
      { channel: "zli:mobile:conditions:appearance", payload: { deviceId: "ios:UDID-1", appearance: "dark" } },
      { channel: "zli:mobile:conditions:location", payload: { deviceId: "ios:UDID-1", latitude: 1.5, longitude: -2 } },
      {
        channel: "zli:mobile:conditions:permission",
        payload: { deviceId: "ios:UDID-1", appId: "com.example.app", permission: "photos", grant: true },
      },
    ]);
  });

  it("refuses bad input before it reaches the desktop", async () => {
    const { fake, calls } = ipc({ message: "Done." });
    const { conditions } = createConditionsApi(fake);
    await expect(
      conditions.setPermission("ios:UDID-1", { appId: "$(reboot)", permission: "photos", grant: true }),
    ).rejects.toThrow();
    await expect(conditions.setLocation("ios:UDID-1", { latitude: 100, longitude: 0 })).rejects.toThrow();
    await expect(
      conditions.sendNotification("ios:UDID-1", { appId: "com.example.app", title: "", body: "" }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("rejects an answer that is not a device settings result", async () => {
    const { fake } = ipc({ appearance: "sepia" });
    const { conditions } = createConditionsApi(fake);
    await expect(conditions.get("ios:UDID-1")).rejects.toThrow();
  });
});
