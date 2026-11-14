// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { parseAppSettings } from "../settings/appSettings.js";
import { applyTypography, DEFAULT_TYPOGRAPHY, fontStack, parseTypography } from "./typography.js";

describe("typography", () => {
  it("defaults to a 16px interface, 14px chat text, 13px code, and a 12px terminal", () => {
    expect(DEFAULT_TYPOGRAPHY).toMatchObject({ interfaceSize: 16, chatSize: 14, codeSize: 13, terminalSize: 12 });
    expect(parseAppSettings(null).typography).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("keeps sizes inside their ranges and drops a font it does not know", () => {
    expect(
      parseTypography({ interfaceSize: 40, chatSize: 3, codeSize: 13.6, terminalSize: "big", sans: "comic" }),
    ).toEqual({ ...DEFAULT_TYPOGRAPHY, interfaceSize: 20, chatSize: 12, codeSize: 14 });
  });

  it("takes any installed font by name, without characters that could break out of the CSS value", () => {
    const { sans } = parseTypography({ sans: 'custom:Fira Sans"; color: red' });
    expect(sans).toBe("custom:Fira Sans color: red");
    expect(fontStack("custom:Fira Code", "mono").startsWith('"Fira Code", ')).toBe(true);
    expect(parseTypography({ mono: "custom:   " }).mono).toBe(DEFAULT_TYPOGRAPHY.mono);
  });

  it("sets the scale, the chat and code sizes, and both font stacks on the root", () => {
    const root = document.createElement("div");
    applyTypography({ ...DEFAULT_TYPOGRAPHY, interfaceSize: 18, chatSize: 15, codeSize: 12, sans: "inter" }, root);
    expect(root.style.getPropertyValue("--zli-ui-scale")).toBe("1.125");
    expect(root.style.getPropertyValue("--zli-text-chat")).toBe("15px");
    expect(root.style.getPropertyValue("--zli-text-code")).toBe("12px");
    expect(root.style.getPropertyValue("--zli-font").startsWith('"Inter Variable"')).toBe(true);
    expect(root.style.getPropertyValue("--zli-mono").startsWith('"Geist Mono Variable"')).toBe(true);
  });
});
