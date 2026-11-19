import { describe, expect, it } from "vitest";
import { isPrivateFile, touchesPrivateFile } from "./privateFiles.js";

const DIR = "C:\\Users\\me\\AppData\\Roaming\\ZLI";

describe("isPrivateFile", () => {
  it("matches ZLI's own files in its data folder, in any case or slash style", () => {
    expect(isPrivateFile(DIR, "C:\\Users\\me\\AppData\\Roaming\\ZLI\\secrets-key.bin")).toBe(true);
    expect(isPrivateFile(DIR, "c:/users/me/appdata/roaming/zli/connected-apps.json")).toBe(true);
    expect(isPrivateFile(DIR, `${DIR}\\mcp-headers\\server\\token`)).toBe(true);
    expect(isPrivateFile(DIR, `${DIR}\\runtime.sqlite-wal`)).toBe(true);
    expect(isPrivateFile(DIR, "\\\\?\\C:\\Users\\me\\AppData\\Roaming\\ZLI\\settings.json")).toBe(true);
  });

  it("sees through .. segments and relative paths", () => {
    expect(isPrivateFile(DIR, "C:/Users/me/AppData/Roaming/other/../ZLI/secrets-key.bin")).toBe(true);
    expect(isPrivateFile(DIR, "../ZLI/secrets-key.bin", "C:/Users/me/AppData/Roaming/work")).toBe(true);
  });

  it("leaves the buddy's home and other folders alone", () => {
    expect(isPrivateFile(DIR, `${DIR}\\buddies\\ada\\notes.json`)).toBe(false);
    expect(isPrivateFile(DIR, "D:\\repo\\package.json")).toBe(false);
    expect(isPrivateFile(DIR, "settings.json", "D:\\repo")).toBe(false);
    expect(isPrivateFile(DIR, "C:/Users/me/AppData/Roaming/ZLI-other/secrets-key.bin")).toBe(false);
  });
});

describe("touchesPrivateFile", () => {
  it("finds a protected path anywhere in a tool call's input", () => {
    expect(touchesPrivateFile(DIR, { locations: [{ path: `${DIR}\\secrets-key.bin` }] })).toBe(true);
    expect(touchesPrivateFile(DIR, [{ file_path: "D:/repo/a.ts" }, undefined])).toBe(false);
  });
});
