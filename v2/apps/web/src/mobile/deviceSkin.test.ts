// @vitest-environment node

import { describe, expect, it } from "vitest";

import { deviceSkin, skinGeometry } from "./deviceSkin.js";

const pixel = { platform: "android", name: "Pixel_8" } as const;
const iphone = { platform: "ios", name: "iPhone 16 Pro" } as const;

describe("deviceSkin", () => {
  it("draws an Android phone with a punch-hole camera and its keys on the right", () => {
    const skin = deviceSkin(pixel, { width: 1080, height: 2400 });
    expect(skin).toMatchObject({ shape: "phone", cutout: "punch-hole", orientation: "portrait" });
    expect(skin.buttons.map(({ name, edge, pressable }) => [name, edge, pressable])).toEqual([
      ["power", "right", true],
      ["volume_up", "right", true],
      ["volume_down", "right", true],
    ]);
    const [, up, down] = skin.buttons;
    expect(down?.start).toBeGreaterThan((up?.start ?? 0) + (up?.length ?? 0));
  });

  it("draws an iPhone with an island, volume on the left that idb cannot press, and power on the right", () => {
    const skin = deviceSkin(iphone, { width: 1206, height: 2622 });
    expect(skin).toMatchObject({ shape: "phone", cutout: "island", orientation: "portrait" });
    expect(skin.buttons.map(({ name, edge, pressable }) => [name, edge, pressable])).toEqual([
      ["volume_up", "left", false],
      ["volume_down", "left", false],
      ["power", "right", true],
    ]);
  });

  it("draws tablets with no cutout, from the name or from squarer proportions", () => {
    expect(
      deviceSkin({ platform: "android", name: "Pixel_Tablet_API_34" }, { width: 1600, height: 2560 }),
    ).toMatchObject({
      shape: "tablet",
      cutout: "none",
    });
    expect(deviceSkin({ platform: "ios", name: "iPad Air 13-inch (M3)" }, { width: 2048, height: 2732 }).shape).toBe(
      "tablet",
    );
    expect(deviceSkin({ platform: "android", name: "SM-X710" }, { width: 1600, height: 2560 }).shape).toBe("tablet");
    expect(deviceSkin({ platform: "android", name: "Medium_Phone_API_35" }, { width: 1600, height: 2560 }).shape).toBe(
      "phone",
    );
    const tablet = deviceSkin({ platform: "android", name: "Galaxy Tab S9" }, { width: 1600, height: 2560 });
    expect(tablet.buttons.map(({ name, edge }) => [name, edge])).toEqual([
      ["power", "top"],
      ["volume_up", "right"],
      ["volume_down", "right"],
    ]);
  });

  it("leaves the cutout off 16:9 phones, which came before them", () => {
    expect(deviceSkin({ platform: "android", name: "Nexus_5" }, { width: 1080, height: 1920 }).cutout).toBe("none");
  });

  it("turns with the device: landscape moves the right-hand keys to the top and the top keys to the left", () => {
    const skin = deviceSkin(pixel, { width: 2400, height: 1080 });
    expect(skin.orientation).toBe("landscape");
    expect(skin.buttons.map(({ edge }) => edge)).toEqual(["top", "top", "top"]);
    const portrait = deviceSkin(pixel, { width: 1080, height: 2400 });
    expect(skin.buttons[0]?.start).toBe(portrait.buttons[0]?.start);

    const tablet = deviceSkin({ platform: "android", name: "Pixel Tablet" }, { width: 2560, height: 1600 });
    expect(tablet.buttons[0]).toMatchObject({ name: "power", edge: "left" });
    expect(tablet.buttons[0]?.start).toBeCloseTo(0.12);
    expect(deviceSkin(iphone, { width: 2622, height: 1206 }).buttons.map(({ edge }) => edge)).toEqual([
      "bottom",
      "bottom",
      "top",
    ]);
  });
});

describe("skinGeometry", () => {
  it("adds an even bezel, thin on phones and wider on tablets, and rounds the screen inside the body's corners", () => {
    const phone = skinGeometry(deviceSkin(pixel, { width: 1080, height: 2400 }), { width: 1080, height: 2400 });
    expect(phone).toEqual({ bezel: 45, width: 1170, height: 2490, radius: 164, screenRadius: 119, rim: 13 });

    const frame = { width: 1600, height: 2560 };
    const tablet = skinGeometry(deviceSkin({ platform: "android", name: "Pixel Tablet" }, frame), frame);
    expect(tablet.bezel).toBe(109);
    expect(tablet.bezel / frame.width).toBeGreaterThan(phone.bezel / 1080);
    expect(tablet.screenRadius).toBeLessThan(tablet.radius);
  });

  it("keeps the same body when the device turns", () => {
    const portrait = skinGeometry(deviceSkin(pixel, { width: 1080, height: 2400 }), { width: 1080, height: 2400 });
    const landscape = skinGeometry(deviceSkin(pixel, { width: 2400, height: 1080 }), { width: 2400, height: 1080 });
    expect([landscape.width, landscape.height, landscape.radius]).toEqual([
      portrait.height,
      portrait.width,
      portrait.radius,
    ]);
  });
});
